// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RixorSavings
/// @notice Testnet-first savings vault for Rixor.
/// @dev v0.1 deliberately does not mint or fabricate yield. Rewards are metadata only
///      until a real reward module is connected in a later version.
contract RixorSavings {
    uint256 private constant BPS_DENOMINATOR = 10_000;

    enum PlanType {
        Flexible,
        Days30,
        Days90,
        Days180,
        Days365
    }

    enum RewardPreference {
        SameAsset,
        USDG
    }

    enum PlanStatus {
        Active,
        Closed
    }

    struct Plan {
        uint256 id;
        address owner;
        uint256 principal;
        PlanType planType;
        RewardPreference rewardPreference;
        bytes32 goal;
        uint64 startedAt;
        uint64 maturesAt;
        PlanStatus status;
    }

    uint256 public nextPlanId = 1;
    mapping(address => uint256) public availableBalance;
    mapping(uint256 => Plan) public plans;
    mapping(address => uint256[]) private userPlanIds;
    uint256 public protocolFees;
    address public immutable feeRecipient;

    uint256 private locked = 1;

    event Deposited(address indexed user, uint256 amount, uint256 newAvailableBalance);
    event AvailableWithdrawn(address indexed user, uint256 amount, uint256 newAvailableBalance);
    event PlanCreated(
        address indexed user,
        uint256 indexed planId,
        uint256 principal,
        PlanType planType,
        RewardPreference rewardPreference,
        bytes32 goal,
        uint64 startedAt,
        uint64 maturesAt
    );
    event PlanWithdrawn(
        address indexed user,
        uint256 indexed planId,
        uint256 principalReturned,
        bool earlyExit,
        uint256 rewardPaid,
        uint256 rewardForfeited
    );
    event EarlyExitFeeCharged(
        address indexed user,
        uint256 indexed planId,
        uint256 feeAmount,
        uint256 feeBps
    );
    event PlanToppedUp(address indexed user, uint256 indexed planId, uint256 amount, uint256 newPrincipal);
    event PlanExtended(
        address indexed user,
        uint256 indexed planId,
        PlanType previousPlanType,
        PlanType newPlanType,
        uint64 newStartedAt,
        uint64 newMaturesAt
    );
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);

    error ZeroAmount();
    error InsufficientAvailableBalance();
    error NotPlanOwner();
    error PlanNotActive();
    error TransferFailed();
    error Reentrancy();
    error NotFeeRecipient();
    error InsufficientProtocolFees();
    error InvalidPlanExtension();

    constructor() {
        feeRecipient = msg.sender;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        if (msg.value == 0) revert ZeroAmount();
        availableBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, availableBalance[msg.sender]);
    }

    function withdrawAvailable(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (availableBalance[msg.sender] < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit AvailableWithdrawn(msg.sender, amount, availableBalance[msg.sender]);
    }

    function createPlan(
        uint256 amount,
        PlanType planType,
        RewardPreference rewardPreference,
        bytes32 goal
    ) external returns (uint256 planId) {
        if (amount == 0) revert ZeroAmount();
        if (availableBalance[msg.sender] < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender] -= amount;

        uint64 startedAt = uint64(block.timestamp);
        uint64 maturesAt = _maturityFor(planType, startedAt);
        planId = nextPlanId++;

        plans[planId] = Plan({
            id: planId,
            owner: msg.sender,
            principal: amount,
            planType: planType,
            rewardPreference: rewardPreference,
            goal: goal,
            startedAt: startedAt,
            maturesAt: maturesAt,
            status: PlanStatus.Active
        });
        userPlanIds[msg.sender].push(planId);

        emit PlanCreated(
            msg.sender,
            planId,
            amount,
            planType,
            rewardPreference,
            goal,
            startedAt,
            maturesAt
        );
    }

    function withdrawPlan(uint256 planId) external nonReentrant {
        Plan storage plan = plans[planId];
        if (plan.owner != msg.sender) revert NotPlanOwner();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();

        bool earlyExit = plan.planType != PlanType.Flexible && block.timestamp < plan.maturesAt;
        uint256 principal = plan.principal;
        uint256 feeBps = earlyExit ? _currentEarlyExitFeeBps(plan, block.timestamp) : 0;
        uint256 earlyExitFee = (principal * feeBps) / BPS_DENOMINATOR;
        uint256 principalReturned = principal - earlyExitFee;

        // v0.1 has no yield engine, so reward values remain zero rather than being fabricated.
        uint256 rewardPaid = 0;
        uint256 rewardForfeited = 0;

        plan.status = PlanStatus.Closed;
        plan.principal = 0;
        protocolFees += earlyExitFee;

        (bool success, ) = payable(msg.sender).call{value: principalReturned}("");
        if (!success) revert TransferFailed();

        if (earlyExitFee > 0) {
            emit EarlyExitFeeCharged(msg.sender, planId, earlyExitFee, feeBps);
        }

        emit PlanWithdrawn(
            msg.sender,
            planId,
            principalReturned,
            earlyExit,
            rewardPaid,
            rewardForfeited
        );
    }

    function topUpPlan(uint256 planId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        Plan storage plan = plans[planId];
        if (plan.owner != msg.sender) revert NotPlanOwner();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();
        if (availableBalance[msg.sender] < amount) revert InsufficientAvailableBalance();

        availableBalance[msg.sender] -= amount;
        plan.principal += amount;

        emit PlanToppedUp(msg.sender, planId, amount, plan.principal);
    }

    function extendPlan(uint256 planId, PlanType newPlanType) external {
        Plan storage plan = plans[planId];
        if (plan.owner != msg.sender) revert NotPlanOwner();
        if (plan.status != PlanStatus.Active) revert PlanNotActive();
        if (newPlanType == PlanType.Flexible) revert InvalidPlanExtension();

        uint256 newDuration = _durationFor(newPlanType);
        uint256 currentDuration = _durationFor(plan.planType);
        if (plan.planType != PlanType.Flexible && newDuration <= currentDuration) {
            revert InvalidPlanExtension();
        }

        PlanType previousPlanType = plan.planType;
        uint64 newStartedAt = uint64(block.timestamp);
        uint64 newMaturesAt = newStartedAt + uint64(newDuration);

        plan.planType = newPlanType;
        plan.startedAt = newStartedAt;
        plan.maturesAt = newMaturesAt;

        emit PlanExtended(msg.sender, planId, previousPlanType, newPlanType, newStartedAt, newMaturesAt);
    }

    function getEarlyWithdrawalQuote(uint256 planId)
        external
        view
        returns (bool earlyExit, uint256 feeBps, uint256 feeAmount, uint256 amountReturned)
    {
        Plan storage plan = plans[planId];
        if (plan.status != PlanStatus.Active) revert PlanNotActive();

        earlyExit = plan.planType != PlanType.Flexible && block.timestamp < plan.maturesAt;
        feeBps = earlyExit ? _currentEarlyExitFeeBps(plan, block.timestamp) : 0;
        feeAmount = (plan.principal * feeBps) / BPS_DENOMINATOR;
        amountReturned = plan.principal - feeAmount;
    }

    function withdrawProtocolFees(uint256 amount) external nonReentrant {
        if (msg.sender != feeRecipient) revert NotFeeRecipient();
        if (amount > protocolFees) revert InsufficientProtocolFees();

        protocolFees -= amount;
        (bool success, ) = payable(feeRecipient).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit ProtocolFeesWithdrawn(feeRecipient, amount);
    }

    function getUserPlanIds(address user) external view returns (uint256[] memory) {
        return userPlanIds[user];
    }

    function getUserPlanCount(address user) external view returns (uint256) {
        return userPlanIds[user].length;
    }

    function _maturityFor(PlanType planType, uint64 startedAt) private pure returns (uint64) {
        uint256 duration = _durationFor(planType);
        if (duration == 0) return 0;
        return startedAt + uint64(duration);
    }

    function _durationFor(PlanType planType) private pure returns (uint256) {
        if (planType == PlanType.Flexible) return 0;
        if (planType == PlanType.Days30) return 30 days;
        if (planType == PlanType.Days90) return 90 days;
        if (planType == PlanType.Days180) return 180 days;
        return 365 days;
    }

    function _maxEarlyExitFeeBps(PlanType planType) private pure returns (uint256) {
        if (planType == PlanType.Days30) return 200;
        if (planType == PlanType.Days90) return 400;
        if (planType == PlanType.Days180) return 600;
        if (planType == PlanType.Days365) return 800;
        return 0;
    }

    function _currentEarlyExitFeeBps(Plan storage plan, uint256 timestamp) private view returns (uint256) {
        if (plan.planType == PlanType.Flexible || timestamp >= plan.maturesAt) return 0;

        uint256 maxFeeBps = _maxEarlyExitFeeBps(plan.planType);
        uint256 duration = uint256(plan.maturesAt) - uint256(plan.startedAt);
        uint256 remaining = uint256(plan.maturesAt) - timestamp;

        // Declines linearly from the plan's maximum fee at the start to 0% at maturity.
        return (maxFeeBps * remaining + duration - 1) / duration;
    }
}
