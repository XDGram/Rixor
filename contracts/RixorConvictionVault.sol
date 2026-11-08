// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBurnableERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

/// @notice Single-asset price source for the vault token. `price` is in any fixed unit
///         (for example USD with 18 decimals); only ratios between prices are used.
interface IRixorPriceOracle {
    function latestPrice() external view returns (uint256 price, uint256 updatedAt);
}

/// @title RixorConvictionVault
/// @notice Tiered conviction locks for one burnable meme token, with ROI targets, stop-loss
///         thresholds, commitment rewards and community challenges.
///
/// Tiers
///   Flexible  1.0x weight. Exit any time; a small fee (up to 1%) applies during the first 7 days.
///   Committed 1.5x weight. Lock for 30-365 days with an ROI target and an optional max loss.
///             Exit is free once the term ends, the target is reached or the max loss is hit.
///             Before that, exiting costs up to 10%, declining to 0% over the term.
///   Diamond   3.0x weight. Lock for 30-365 days with an ROI target and a required max loss.
///             No early exit. Withdrawal opens when the target is reached, the max loss is hit,
///             the chosen term ends, or the price oracle has been stale for 7 days.
///             The term is a hard backstop so no one can be trapped indefinitely.
///
/// Rewards
///   Fees are split 50/50: half is burned, half is added to the commitment reward pool. Anyone
///   can also fund the pool. The pool accrues to open locks by weight and is paid out only
///   when a lock completes (term ended, target reached, Flexible window passed, or oracle
///   escape). Rewards from locks that exit early or by stop-loss are forfeited back to the pool.
///
/// Challenges
///   Anyone can sponsor a challenge by escrowing tokens. Holders join with an open lock. After
///   the challenge ends it is finalized, participants who held through the end (and, for
///   performance challenges, reached the ROI target at the final price) qualify, and the
///   pool is split equally between them. Unclaimed or failed pools return to the sponsor.
///
/// There is no owner and no admin function. The oracle is fixed at deployment.
contract RixorConvictionVault {
    uint256 private constant BPS = 10_000;
    uint256 private constant ACC_PRECISION = 1e18;

    uint8 public constant FLEXIBLE = 0;
    uint8 public constant COMMITTED = 1;
    uint8 public constant DIAMOND = 2;

    uint8 public constant CHALLENGE_HOLD = 0;
    uint8 public constant CHALLENGE_ROI = 1;

    uint256 public constant FLEX_WINDOW = 7 days;
    uint256 public constant FLEX_MAX_FEE_BPS = 100;
    uint256 public constant COMMITTED_MAX_FEE_BPS = 1_000;
    uint256 public constant MIN_TERM_DAYS = 30;
    uint256 public constant MAX_TERM_DAYS = 365;
    uint256 public constant MIN_ROI_TARGET_BPS = 100;
    uint256 public constant MAX_ROI_TARGET_BPS = 100_000;
    uint256 public constant MIN_MAX_LOSS_BPS = 500;
    uint256 public constant MAX_MAX_LOSS_BPS = 9_000;
    uint256 public constant ORACLE_ESCAPE = 7 days;
    uint256 public constant CLAIM_WINDOW = 3 days;
    uint256 public constant MAX_CHALLENGE_LENGTH = 365 days;

    enum ExitReason {
        Locked,
        EarlyWithFee,
        FlexWindowPassed,
        TermEnded,
        TargetReached,
        StopLoss,
        OracleStale
    }

    struct Lock {
        address owner;
        uint8 tier;
        bool open;
        uint64 startedAt;
        uint64 endsAt;
        uint64 closedAt;
        uint32 roiTargetBps;
        uint32 maxLossBps;
        uint256 amount;
        uint256 weight;
        uint256 entryPrice;
        uint256 rewardDebt;
    }

    struct Challenge {
        address sponsor;
        uint8 kind;
        uint8 minTier;
        bool finalized;
        bool refunded;
        uint64 joinBy;
        uint64 endsAt;
        uint64 claimEndsAt;
        uint32 roiTargetBps;
        bytes32 title;
        uint256 minAmount;
        uint256 targetTotal;
        uint256 rewardPool;
        uint256 participants;
        uint256 committedTotal;
        uint256 snapshotPrice;
        uint256 qualifiedCount;
        uint256 qualifiedTotal;
    }

    struct Entry {
        uint256 lockId;
        bool qualified;
        bool claimed;
    }

    IBurnableERC20 public immutable token;
    IRixorPriceOracle public immutable oracle;
    uint256 public immutable maxPriceAge;

    uint256 public nextLockId = 1;
    uint256 public nextChallengeId = 1;
    uint256 public openLocks;
    uint256 public totalLocked;
    uint256 public totalWeight;
    uint256 public accRewardPerWeight;
    uint256 public totalBurned;
    uint256 public totalFeesToPool;
    uint256 public totalFunded;
    uint256 public totalRewardsPaid;
    uint256 public completedLocks;
    uint256 public challengeEscrow;

    mapping(uint256 => Lock) public locks;
    mapping(address => uint256[]) private ownerLockIds;
    mapping(uint256 => Challenge) public challenges;
    mapping(uint256 => mapping(address => Entry)) public entries;
    mapping(uint256 => address[]) private challengeParticipants;

    uint256 private reentrancyStatus = 1;

    event Locked(
        address indexed owner,
        uint256 indexed lockId,
        uint8 tier,
        uint256 amount,
        uint256 weight,
        uint256 entryPrice,
        uint64 endsAt,
        uint32 roiTargetBps,
        uint32 maxLossBps
    );
    event Exited(
        address indexed owner,
        uint256 indexed lockId,
        ExitReason reason,
        uint256 amountReturned,
        uint256 rewardPaid,
        uint256 fee,
        uint256 burned,
        uint256 forfeited
    );
    event RewardsFunded(address indexed funder, uint256 amount);
    event ChallengeCreated(uint256 indexed challengeId, address indexed sponsor, uint8 kind, uint256 rewardPool, uint64 joinBy, uint64 endsAt, bytes32 title);
    event ChallengeJoined(uint256 indexed challengeId, address indexed participant, uint256 indexed lockId, uint256 amount);
    event ChallengeFinalized(uint256 indexed challengeId, uint256 snapshotPrice, uint64 claimEndsAt);
    event ChallengeQualified(uint256 indexed challengeId, address indexed participant);
    event ChallengeRewardClaimed(uint256 indexed challengeId, address indexed participant, uint256 amount);
    event ChallengeRefunded(uint256 indexed challengeId, address indexed sponsor, uint256 amount);

    error ZeroAmount();
    error InvalidTier();
    error InvalidTerm();
    error InvalidTarget();
    error InvalidMaxLoss();
    error PriceUnavailable();
    error NotLockOwner();
    error LockClosed();
    error StillLocked();
    error FeeTooHigh();
    error NoOpenLocks();
    error TransferFailed();
    error Reentrancy();
    error InvalidChallenge();
    error ChallengeClosed();
    error NotEligible();
    error AlreadyJoined();
    error NotReady();
    error NothingToClaim();

    constructor(address token_, address oracle_, uint256 maxPriceAge_) {
        if (token_ == address(0) || oracle_ == address(0) || maxPriceAge_ == 0) revert InvalidChallenge();
        token = IBurnableERC20(token_);
        oracle = IRixorPriceOracle(oracle_);
        maxPriceAge = maxPriceAge_;
    }

    modifier nonReentrant() {
        if (reentrancyStatus != 1) revert Reentrancy();
        reentrancyStatus = 2;
        _;
        reentrancyStatus = 1;
    }

    // ------------------------------------------------------------------ tiers

    function tierWeightBps(uint8 tier) public pure returns (uint256) {
        if (tier == FLEXIBLE) return 10_000;
        if (tier == COMMITTED) return 15_000;
        if (tier == DIAMOND) return 30_000;
        revert InvalidTier();
    }

    // ------------------------------------------------------------------ locks

    /// @param termDays Ignored for Flexible. 30-365 for Committed and Diamond.
    /// @param roiTargetBps Ignored for Flexible. Required for Committed and Diamond (+1% to +1000%).
    /// @param maxLossBps Ignored for Flexible. Optional (0) for Committed, required for Diamond (5%-90%).
    function lock(uint256 amount, uint8 tier, uint16 termDays, uint32 roiTargetBps, uint32 maxLossBps)
        external
        nonReentrant
        returns (uint256 lockId)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 weightBps = tierWeightBps(tier);
        (uint256 price, bool fresh,) = _price();
        if (!fresh) revert PriceUnavailable();

        uint256 duration = FLEX_WINDOW;
        if (tier == FLEXIBLE) {
            roiTargetBps = 0;
            maxLossBps = 0;
        } else {
            if (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS) revert InvalidTerm();
            if (roiTargetBps < MIN_ROI_TARGET_BPS || roiTargetBps > MAX_ROI_TARGET_BPS) revert InvalidTarget();
            bool lossRequired = tier == DIAMOND;
            if (maxLossBps == 0 ? lossRequired : (maxLossBps < MIN_MAX_LOSS_BPS || maxLossBps > MAX_MAX_LOSS_BPS)) {
                revert InvalidMaxLoss();
            }
            duration = uint256(termDays) * 1 days;
        }

        uint256 received = _pull(msg.sender, amount);
        uint256 weight = (received * weightBps) / BPS;

        lockId = nextLockId++;
        Lock storage position = locks[lockId];
        position.owner = msg.sender;
        position.tier = tier;
        position.open = true;
        position.startedAt = uint64(block.timestamp);
        position.endsAt = uint64(block.timestamp + duration);
        position.roiTargetBps = roiTargetBps;
        position.maxLossBps = maxLossBps;
        position.amount = received;
        position.weight = weight;
        position.entryPrice = price;
        position.rewardDebt = (weight * accRewardPerWeight) / ACC_PRECISION;
        ownerLockIds[msg.sender].push(lockId);

        openLocks += 1;
        totalLocked += received;
        totalWeight += weight;

        emit Locked(msg.sender, lockId, tier, received, weight, price, position.endsAt, roiTargetBps, maxLossBps);
    }

    /// @notice Withdraw a lock. `maxFeeBps` protects against the fee changing between quote and
    ///         execution (for example if the price falls back below the target).
    function exit(uint256 lockId, uint256 maxFeeBps) external nonReentrant {
        Lock storage position = locks[lockId];
        if (position.owner != msg.sender) revert NotLockOwner();
        if (!position.open) revert LockClosed();

        (ExitReason reason, uint256 feeBps,,,) = _exitStatus(position);
        if (reason == ExitReason.Locked) revert StillLocked();
        if (feeBps > maxFeeBps) revert FeeTooHigh();

        uint256 amount = position.amount;
        uint256 reward = _pending(position);
        position.open = false;
        position.closedAt = uint64(block.timestamp);
        openLocks -= 1;
        totalLocked -= amount;
        totalWeight -= position.weight;

        bool completed = reason != ExitReason.EarlyWithFee && reason != ExitReason.StopLoss;
        if (completed) {
            completedLocks += 1;
            totalRewardsPaid += reward;
            _push(msg.sender, amount + reward);
            emit Exited(msg.sender, lockId, reason, amount, reward, 0, 0, 0);
            return;
        }

        uint256 fee = (amount * feeBps) / BPS;
        uint256 burned = fee / 2;
        uint256 toPool = (fee - burned) + reward;
        if (totalWeight == 0) {
            burned += toPool;
            toPool = 0;
        } else if (toPool > 0) {
            accRewardPerWeight += (toPool * ACC_PRECISION) / totalWeight;
            totalFeesToPool += toPool;
        }
        if (burned > 0) {
            totalBurned += burned;
            token.burn(burned);
        }
        _push(msg.sender, amount - fee);
        emit Exited(msg.sender, lockId, reason, amount - fee, 0, fee, burned, reward);
    }

    /// @notice Add tokens to the commitment reward pool, shared by all open locks by weight.
    function fundRewards(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (totalWeight == 0) revert NoOpenLocks();
        uint256 received = _pull(msg.sender, amount);
        accRewardPerWeight += (received * ACC_PRECISION) / totalWeight;
        totalFunded += received;
        emit RewardsFunded(msg.sender, received);
    }

    // ------------------------------------------------------------- challenges

    function createChallenge(
        uint8 kind,
        uint8 minTier,
        uint256 minAmount,
        uint32 roiTargetBps,
        uint256 targetTotal,
        uint64 joinBy,
        uint64 endsAt,
        uint256 rewardAmount,
        bytes32 title
    ) external nonReentrant returns (uint256 challengeId) {
        if (kind > CHALLENGE_ROI || minTier > DIAMOND) revert InvalidChallenge();
        if (joinBy <= block.timestamp || endsAt < joinBy || endsAt > block.timestamp + MAX_CHALLENGE_LENGTH) revert InvalidChallenge();
        if (kind == CHALLENGE_ROI && (roiTargetBps < MIN_ROI_TARGET_BPS || roiTargetBps > MAX_ROI_TARGET_BPS)) revert InvalidTarget();
        if (kind == CHALLENGE_HOLD) roiTargetBps = 0;

        uint256 received = _pull(msg.sender, rewardAmount);
        challengeId = nextChallengeId++;
        Challenge storage challenge = challenges[challengeId];
        challenge.sponsor = msg.sender;
        challenge.kind = kind;
        challenge.minTier = minTier;
        challenge.joinBy = joinBy;
        challenge.endsAt = endsAt;
        challenge.roiTargetBps = roiTargetBps;
        challenge.title = title;
        challenge.minAmount = minAmount;
        challenge.targetTotal = targetTotal;
        challenge.rewardPool = received;
        challengeEscrow += received;

        emit ChallengeCreated(challengeId, msg.sender, kind, received, joinBy, endsAt, title);
    }

    function joinChallenge(uint256 challengeId, uint256 lockId) external {
        Challenge storage challenge = challenges[challengeId];
        if (challenge.sponsor == address(0)) revert InvalidChallenge();
        if (block.timestamp > challenge.joinBy) revert ChallengeClosed();
        Entry storage entry = entries[challengeId][msg.sender];
        if (entry.lockId != 0) revert AlreadyJoined();

        Lock storage position = locks[lockId];
        if (position.owner != msg.sender) revert NotLockOwner();
        if (!position.open) revert LockClosed();
        if (position.tier < challenge.minTier || position.amount < challenge.minAmount) revert NotEligible();

        entry.lockId = lockId;
        challenge.participants += 1;
        challenge.committedTotal += position.amount;
        challengeParticipants[challengeId].push(msg.sender);

        emit ChallengeJoined(challengeId, msg.sender, lockId, position.amount);
    }

    /// @notice Close a finished challenge and open its claim window. Anyone can call it.
    function finalizeChallenge(uint256 challengeId) external {
        Challenge storage challenge = challenges[challengeId];
        if (challenge.sponsor == address(0) || challenge.finalized || challenge.refunded) revert InvalidChallenge();
        if (block.timestamp < challenge.endsAt) revert NotReady();
        if (challenge.kind == CHALLENGE_ROI) {
            (uint256 price, bool fresh,) = _price();
            if (!fresh) revert PriceUnavailable();
            challenge.snapshotPrice = price;
        }
        challenge.finalized = true;
        challenge.claimEndsAt = uint64(block.timestamp + CLAIM_WINDOW);
        emit ChallengeFinalized(challengeId, challenge.snapshotPrice, challenge.claimEndsAt);
    }

    /// @notice Prove you met the challenge during its claim window.
    function qualify(uint256 challengeId) external {
        Challenge storage challenge = challenges[challengeId];
        if (!challenge.finalized || block.timestamp > challenge.claimEndsAt) revert NotReady();
        Entry storage entry = entries[challengeId][msg.sender];
        if (entry.lockId == 0 || entry.qualified) revert NotEligible();
        if (!_meetsChallenge(challenge, locks[entry.lockId])) revert NotEligible();

        entry.qualified = true;
        challenge.qualifiedCount += 1;
        challenge.qualifiedTotal += locks[entry.lockId].amount;
        emit ChallengeQualified(challengeId, msg.sender);
    }

    /// @notice After the claim window, each qualified participant takes an equal share.
    function claimChallengeReward(uint256 challengeId) external nonReentrant {
        Challenge storage challenge = challenges[challengeId];
        if (!challenge.finalized || block.timestamp <= challenge.claimEndsAt || challenge.refunded) revert NotReady();
        if (challenge.qualifiedTotal < challenge.targetTotal) revert NotEligible();
        Entry storage entry = entries[challengeId][msg.sender];
        if (!entry.qualified || entry.claimed) revert NothingToClaim();

        entry.claimed = true;
        uint256 share = challenge.rewardPool / challenge.qualifiedCount;
        challengeEscrow -= share;
        _push(msg.sender, share);
        emit ChallengeRewardClaimed(challengeId, msg.sender, share);
    }

    /// @notice Return the pool to the sponsor if nobody qualified, the community target was
    ///         missed, or the challenge could not be finalized within ORACLE_ESCAPE of ending.
    function refundChallenge(uint256 challengeId) external nonReentrant {
        Challenge storage challenge = challenges[challengeId];
        if (challenge.sponsor == address(0) || challenge.refunded) revert InvalidChallenge();
        bool failedAfterWindow = challenge.finalized
            && block.timestamp > challenge.claimEndsAt
            && (challenge.qualifiedCount == 0 || challenge.qualifiedTotal < challenge.targetTotal);
        bool neverFinalized = !challenge.finalized && block.timestamp > uint256(challenge.endsAt) + ORACLE_ESCAPE;
        if (!failedAfterWindow && !neverFinalized) revert NotReady();

        challenge.refunded = true;
        uint256 amount = challenge.rewardPool;
        challengeEscrow -= amount;
        _push(challenge.sponsor, amount);
        emit ChallengeRefunded(challengeId, challenge.sponsor, amount);
    }

    // ------------------------------------------------------------------ views

    function currentPrice() external view returns (uint256 price, bool fresh, uint256 updatedAt) {
        return _price();
    }

    /// @notice Whether a lock can be withdrawn now, why, at what fee, and its live ROI.
    function exitStatus(uint256 lockId)
        external
        view
        returns (ExitReason reason, uint256 feeBps, int256 roiBps, bool priceFresh, uint256 price)
    {
        Lock storage position = locks[lockId];
        if (!position.open) revert LockClosed();
        return _exitStatus(position);
    }

    function pendingReward(uint256 lockId) external view returns (uint256) {
        Lock storage position = locks[lockId];
        if (!position.open) return 0;
        return _pending(position);
    }

    function getOwnerLockIds(address owner) external view returns (uint256[] memory) {
        return ownerLockIds[owner];
    }

    function getChallengeParticipants(uint256 challengeId) external view returns (address[] memory) {
        return challengeParticipants[challengeId];
    }

    // -------------------------------------------------------------- internals

    function _price() private view returns (uint256 price, bool fresh, uint256 updatedAt) {
        try oracle.latestPrice() returns (uint256 latest, uint256 timestamp) {
            price = latest;
            updatedAt = timestamp;
            fresh = latest > 0 && timestamp <= block.timestamp && block.timestamp - timestamp <= maxPriceAge;
        } catch {
            fresh = false;
        }
    }

    function _roiBps(uint256 entryPrice, uint256 price) private pure returns (int256) {
        return ((int256(price) - int256(entryPrice)) * int256(BPS)) / int256(entryPrice);
    }

    function _exitStatus(Lock storage position)
        private
        view
        returns (ExitReason reason, uint256 feeBps, int256 roiBps, bool fresh, uint256 price)
    {
        uint256 updatedAt;
        (price, fresh, updatedAt) = _price();
        if (fresh) roiBps = _roiBps(position.entryPrice, price);

        uint256 remaining = block.timestamp >= position.endsAt ? 0 : position.endsAt - block.timestamp;
        uint256 duration = uint256(position.endsAt) - uint256(position.startedAt);

        if (position.tier == FLEXIBLE) {
            if (remaining == 0) return (ExitReason.FlexWindowPassed, 0, roiBps, fresh, price);
            return (ExitReason.EarlyWithFee, _ceilDiv(FLEX_MAX_FEE_BPS * remaining, duration), roiBps, fresh, price);
        }
        if (remaining == 0) return (ExitReason.TermEnded, 0, roiBps, fresh, price);
        if (fresh && roiBps >= int256(uint256(position.roiTargetBps))) return (ExitReason.TargetReached, 0, roiBps, fresh, price);
        if (fresh && position.maxLossBps > 0 && roiBps <= -int256(uint256(position.maxLossBps))) {
            return (ExitReason.StopLoss, 0, roiBps, fresh, price);
        }
        if (position.tier == DIAMOND) {
            bool escape = !fresh && (updatedAt > block.timestamp || block.timestamp - updatedAt > ORACLE_ESCAPE);
            return (escape ? ExitReason.OracleStale : ExitReason.Locked, 0, roiBps, fresh, price);
        }
        return (ExitReason.EarlyWithFee, _ceilDiv(COMMITTED_MAX_FEE_BPS * remaining, duration), roiBps, fresh, price);
    }

    function _meetsChallenge(Challenge storage challenge, Lock storage position) private view returns (bool) {
        bool heldThroughEnd = position.open || position.closedAt >= challenge.endsAt;
        if (!heldThroughEnd) return false;
        if (challenge.kind == CHALLENGE_HOLD) return true;
        return _roiBps(position.entryPrice, challenge.snapshotPrice) >= int256(uint256(challenge.roiTargetBps));
    }

    function _pending(Lock storage position) private view returns (uint256) {
        return (position.weight * accRewardPerWeight) / ACC_PRECISION - position.rewardDebt;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _pull(address from, uint256 amount) private returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = token.balanceOf(address(this));
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IBurnableERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
    }

    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IBurnableERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
