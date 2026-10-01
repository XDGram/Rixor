// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RixorSavings
/// @notice Testnet-first savings vault for Rixor.
/// @dev v0.1 deliberately does not mint or fabricate yield. Rewards are metadata only
///      until a real reward module is connected in a later version.
contract RixorSavings {
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

    error ZeroAmount();
    error InsufficientAvailableBalance();
    error NotPlanOwner();
    error PlanNotActive();
    error TransferFailed();
    error Reentrancy();

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

        // v0.1 has no yield engine, so reward values remain zero rather than being fabricated.
        uint256 rewardPaid = 0;
        uint256 rewardForfeited = 0;

        plan.status = PlanStatus.Closed;
        plan.principal = 0;

        (bool success, ) = payable(msg.sender).call{value: principal}("");
        if (!success) revert TransferFailed();

        emit PlanWithdrawn(
            msg.sender,
            planId,
            principal,
            earlyExit,
            rewardPaid,
            rewardForfeited
        );
    }

    function getUserPlanIds(address user) external view returns (uint256[] memory) {
        return userPlanIds[user];
    }

    function getUserPlanCount(address user) external view returns (uint256) {
        return userPlanIds[user].length;
    }

    function _maturityFor(PlanType planType, uint64 startedAt) private pure returns (uint64) {
        if (planType == PlanType.Flexible) return 0;
        if (planType == PlanType.Days30) return startedAt + 30 days;
        if (planType == PlanType.Days90) return startedAt + 90 days;
        if (planType == PlanType.Days180) return startedAt + 180 days;
        return startedAt + 365 days;
    }
}
