// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRixorLocker} from "./interfaces/IRixorLocker.sol";

/// @title RixorLocker (V2)
/// @notice Time-based conviction locks for a curated allowlist of community meme tokens. Users lock tokens
///         they already hold; no reward or utility token is required to lock.
///
/// Tiers (time only; no price oracle):
///   Flexible  0.5x  exit any time, no fee.
///   Committed 1.5x  30-90 day term; exiting early costs a fee of up to 10%, falling linearly to 0 at the end.
///   Diamond   2.5x  30-90 day term; no exit before the end of the term.
///
/// Risk classes (set per token at listing; they limit what a user can commit to, never what they can withdraw):
///   Class A  Flexible, Committed and Diamond; terms up to 90 days.
///   Class B  Flexible and Committed only; terms up to 60 days.
///
/// Every lock and exit writes a per-token weight checkpoint (weight = amount x tier multiplier). Reward
/// contracts read these checkpoints; the Locker never calls them, so exits cannot depend on them.
///
/// Administration (owner = a Safe, required to be a contract):
///   - token listing, unit-size changes, cap increases, class upgrades and re-enabling locks are timelocked
///     (48h) and bounded;
///   - lowering a cap, downgrading a class or disabling new locks for a token is immediate (risk-reducing only).
/// Guardian (a Safe) or owner:
///   - pause new activity (reversible by the owner);
///   - release one token (irreversible): its positions, including Diamond, can exit immediately with no fee;
///   - activate an irreversible global emergency with the same effect for every token.
///
/// No account can move a user's principal except that user via exit(). There is no upgrade path, no
/// withdrawal function for admins, and no way to block exits.
contract RixorLocker is IRixorLocker {
    // ------------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint8 public constant TIER_FLEXIBLE = 0;
    uint8 public constant TIER_COMMITTED = 1;
    uint8 public constant TIER_DIAMOND = 2;

    uint256 public constant FLEXIBLE_MULTIPLIER_BPS = 5_000;
    uint256 public constant COMMITTED_MULTIPLIER_BPS = 15_000;
    uint256 public constant DIAMOND_MULTIPLIER_BPS = 25_000;

    uint8 public constant CLASS_A = 1;
    uint8 public constant CLASS_B = 2;

    uint256 public constant MIN_TERM_DAYS = 30;
    uint256 public constant MAX_TERM_DAYS = 90;
    uint256 public constant CLASS_B_MAX_TERM_DAYS = 60;
    uint256 public constant COMMITTED_MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_POSITION_UNITS = 50;

    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant UNIT_CHANGE_INTERVAL = 7 days;
    uint256 public constant MAX_CAP_GROWTH_FACTOR = 2;
    /// @dev Unit changes are bounded to [50%, 150%] of the current value per update.
    uint256 public constant UNIT_CHANGE_MIN_BPS = 5_000;
    uint256 public constant UNIT_CHANGE_MAX_BPS = 15_000;

    /// @notice Early-exit fees are sent here (a conventional burn address).
    address public constant FEE_SINK = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------ types

    struct TokenConfig {
        bool listed;
        bool locksEnabled;
        uint8 decimals;
        uint8 riskClass;
        uint64 lastUnitChange;
        uint64 releasedAt;
        uint256 unitAmount;
        uint256 maxTotalLocked;
        uint256 totalLocked;
        uint256 totalWeight;
    }

    /// @notice Listing parameters. `riskClass` is CLASS_A or CLASS_B.
    struct Listing {
        address token;
        uint256 unitAmount;
        uint256 maxTotalLocked;
        uint8 riskClass;
    }

    struct Position {
        address owner;
        uint8 tier;
        uint64 startedAt;
        uint64 endsAt;
        uint64 closedAt;
        address token;
        uint32 startCheckpoint;
        uint32 endCheckpoint;
        uint256 amount;
        uint256 weight;
    }

    /// @notice Total weight of a token in force from `time` until the next checkpoint.
    struct Checkpoint {
        uint64 time;
        uint192 totalWeight;
    }

    struct PendingListing {
        uint256 unitAmount;
        uint256 maxTotalLocked;
        uint8 riskClass;
        uint64 eta;
    }

    struct PendingValue {
        uint256 value;
        uint64 eta;
    }

    // ------------------------------------------------------------------ storage

    address public override owner;
    address public pendingOwner;
    address public guardian;

    bool public override paused;
    uint64 public override emergencyActivatedAt;

    uint256 public nextPositionId = 1;

    mapping(address token => TokenConfig) internal _tokens;
    address[] internal _listedTokens;
    mapping(uint256 positionId => Position) internal _positions;
    mapping(address account => uint256[]) internal _positionsByOwner;

    mapping(address token => PendingListing) public pendingListing;
    mapping(address token => PendingValue) public pendingUnitAmount;
    mapping(address token => PendingValue) public pendingCapIncrease;
    mapping(address token => uint64 eta) public pendingEnableLocks;
    mapping(address token => PendingValue) public pendingClassUpgrade;
    mapping(address token => Checkpoint[]) internal _checkpoints;

    /// @notice Fees that could not be delivered to FEE_SINK. They stay in this contract permanently
    ///         (there is no function to withdraw them), which is economically equivalent to a burn.
    mapping(address token => uint256) public retainedFees;

    uint256 private _reentrancy = 1;

    // ------------------------------------------------------------------ events

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event EmergencyActivated(address indexed by, uint64 at);

    event TokenListed(
        address indexed token, uint8 decimals, uint256 unitAmount, uint256 maxTotalLocked, uint8 riskClass
    );
    event ListingProposed(
        address indexed token, uint256 unitAmount, uint256 maxTotalLocked, uint8 riskClass, uint64 eta
    );
    event ListingCancelled(address indexed token);
    event UnitAmountProposed(address indexed token, uint256 currentUnit, uint256 newUnit, uint64 eta);
    event UnitAmountChanged(address indexed token, uint256 previousUnit, uint256 newUnit);
    event UnitAmountCancelled(address indexed token);
    event CapIncreaseProposed(address indexed token, uint256 currentCap, uint256 newCap, uint64 eta);
    event CapChanged(address indexed token, uint256 previousCap, uint256 newCap);
    event CapIncreaseCancelled(address indexed token);
    event LocksDisabled(address indexed token);
    event EnableLocksProposed(address indexed token, uint64 eta);
    event LocksEnabled(address indexed token);
    event EnableLocksCancelled(address indexed token);
    event RiskClassChanged(address indexed token, uint8 previousClass, uint8 newClass);
    event ClassUpgradeProposed(address indexed token, uint8 newClass, uint64 eta);
    event ClassUpgradeCancelled(address indexed token);
    event TokenReleased(address indexed token, address indexed by, uint64 at);
    event Checkpointed(address indexed token, uint256 indexed index, uint64 time, uint256 totalWeight);

    event Locked(
        address indexed owner,
        uint256 indexed positionId,
        address indexed token,
        uint256 amount,
        uint256 weight,
        uint8 tier,
        uint64 startedAt,
        uint64 endsAt
    );
    event Exited(
        address indexed owner,
        uint256 indexed positionId,
        address indexed token,
        uint256 amountReturned,
        uint256 fee,
        bool feeBurned,
        bool released
    );

    // ------------------------------------------------------------------ errors

    error NotOwner();
    error NotPendingOwner();
    error NotGuardian();
    error NotContract(address account);
    error ZeroAddress();
    error Reentrancy();
    error IsPaused();
    error EmergencyActive();
    error InvalidToken(address token);
    error AlreadyListed(address token);
    error NotListed(address token);
    error LocksNotEnabled(address token);
    error InvalidAmount();
    error InvalidTier();
    error InvalidTerm();
    error CapExceeded(address token);
    error IncompatibleToken(address token);
    error TransferFailed(address token);
    error NotPositionOwner();
    error PositionClosed();
    error StillLocked();
    error FeeTooHigh(uint256 feeBps, uint256 maxFeeBps);
    error NothingPending();
    error TimelockNotReady(uint64 eta);
    error OutOfBounds();
    error TooSoon(uint64 allowedAt);
    error InvalidRiskClass();
    error TierNotAllowed(uint8 tier);
    error TokenReleasedAlready(address token);

    // ------------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    // ------------------------------------------------------------------ construction

    /// @param owner_ Administrative Safe. Must be a contract; an EOA owner is rejected.
    /// @param guardian_ Emergency Safe. Must be a contract.
    /// @param initial Initial allowlist (exact addresses). Public at deployment, so not timelocked. May be empty.
    constructor(address owner_, address guardian_, Listing[] memory initial) {
        _requireContract(owner_);
        _requireContract(guardian_);
        owner = owner_;
        guardian = guardian_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianChanged(address(0), guardian_);
        for (uint256 i = 0; i < initial.length; i++) {
            _list(initial[i].token, initial[i].unitAmount, initial[i].maxTotalLocked, initial[i].riskClass);
        }
    }

    // ------------------------------------------------------------------ ownership and roles

    /// @notice Two-step ownership transfer. The new owner must be a contract (a Safe).
    function transferOwnership(address newOwner) external onlyOwner {
        _requireContract(newOwner);
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        _requireContract(newGuardian);
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Stops new locks, challenge creation, joins and sponsorship. Exits, settlement, claims,
    ///         refunds and sweeps are never affected.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (emergencyActivatedAt != 0) revert EmergencyActive();
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Irreversible. All positions become exitable immediately with no fee; challenges still running
    ///         at this moment become refund-only (enforced by RixorChallenges); reward accrual stops at this
    ///         timestamp (enforced by RixorRewards). New activity stops for good.
    function activateEmergency() external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        if (emergencyActivatedAt != 0) revert EmergencyActive();
        emergencyActivatedAt = uint64(block.timestamp);
        paused = true;
        emit EmergencyActivated(msg.sender, uint64(block.timestamp));
    }

    /// @notice Irreversible, for an incident affecting one token (exploit, hostile admin action, liquidity
    ///         removed). Every position in `token`, including Diamond, can exit immediately with no fee; new
    ///         locks in `token` stop for good; reward accrual for `token` stops at this timestamp. This can only
    ///         make exits easier: it never moves funds.
    function releaseToken(address token) external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        TokenConfig storage config = _listed(token);
        if (config.releasedAt != 0) revert TokenReleasedAlready(token);
        config.releasedAt = uint64(block.timestamp);
        config.locksEnabled = false;
        delete pendingEnableLocks[token];
        delete pendingClassUpgrade[token];
        emit TokenReleased(token, msg.sender, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ token registry (timelocked)

    function proposeListing(address token, uint256 unitAmount_, uint256 maxTotalLocked_, uint8 riskClass_)
        external
        onlyOwner
    {
        if (_tokens[token].listed) revert AlreadyListed(token);
        _validateToken(token, unitAmount_, maxTotalLocked_);
        _checkClass(riskClass_);
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingListing[token] = PendingListing(unitAmount_, maxTotalLocked_, riskClass_, eta);
        emit ListingProposed(token, unitAmount_, maxTotalLocked_, riskClass_, eta);
    }

    function cancelListing(address token) external onlyOwner {
        if (pendingListing[token].eta == 0) revert NothingPending();
        delete pendingListing[token];
        emit ListingCancelled(token);
    }

    /// @notice Anyone may execute a matured, published change.
    function executeListing(address token) external {
        PendingListing memory pending = pendingListing[token];
        if (pending.eta == 0) revert NothingPending();
        if (block.timestamp < pending.eta) revert TimelockNotReady(pending.eta);
        delete pendingListing[token];
        _list(token, pending.unitAmount, pending.maxTotalLocked, pending.riskClass);
    }

    /// @notice Propose a new unit size, bounded to [50%, 150%] of the current one. Takes effect only for
    ///         challenges created after execution; existing positions store no points.
    function proposeUnitAmount(address token, uint256 newUnit) external onlyOwner {
        TokenConfig storage config = _listed(token);
        _checkUnitBounds(config.unitAmount, newUnit);
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingUnitAmount[token] = PendingValue(newUnit, eta);
        emit UnitAmountProposed(token, config.unitAmount, newUnit, eta);
    }

    function cancelUnitAmount(address token) external onlyOwner {
        if (pendingUnitAmount[token].eta == 0) revert NothingPending();
        delete pendingUnitAmount[token];
        emit UnitAmountCancelled(token);
    }

    function executeUnitAmount(address token) external {
        TokenConfig storage config = _listed(token);
        PendingValue memory pending = pendingUnitAmount[token];
        if (pending.eta == 0) revert NothingPending();
        if (block.timestamp < pending.eta) revert TimelockNotReady(pending.eta);
        uint64 allowedAt = config.lastUnitChange + uint64(UNIT_CHANGE_INTERVAL);
        if (block.timestamp < allowedAt) revert TooSoon(allowedAt);
        _checkUnitBounds(config.unitAmount, pending.value);
        delete pendingUnitAmount[token];
        emit UnitAmountChanged(token, config.unitAmount, pending.value);
        config.unitAmount = pending.value;
        config.lastUnitChange = uint64(block.timestamp);
    }

    /// @notice Immediate, risk-reducing only: Class A -> Class B. Existing positions keep their terms.
    function downgradeClass(address token) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (config.riskClass != CLASS_A) revert OutOfBounds();
        config.riskClass = CLASS_B;
        delete pendingClassUpgrade[token];
        emit RiskClassChanged(token, CLASS_A, CLASS_B);
    }

    /// @notice Class B -> Class A is timelocked.
    function proposeClassUpgrade(address token) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (config.riskClass != CLASS_B || config.releasedAt != 0) revert OutOfBounds();
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingClassUpgrade[token] = PendingValue(CLASS_A, eta);
        emit ClassUpgradeProposed(token, CLASS_A, eta);
    }

    function cancelClassUpgrade(address token) external onlyOwner {
        if (pendingClassUpgrade[token].eta == 0) revert NothingPending();
        delete pendingClassUpgrade[token];
        emit ClassUpgradeCancelled(token);
    }

    function executeClassUpgrade(address token) external {
        TokenConfig storage config = _listed(token);
        PendingValue memory pending = pendingClassUpgrade[token];
        if (pending.eta == 0) revert NothingPending();
        if (block.timestamp < pending.eta) revert TimelockNotReady(pending.eta);
        if (config.riskClass != CLASS_B || config.releasedAt != 0) revert OutOfBounds();
        delete pendingClassUpgrade[token];
        config.riskClass = CLASS_A;
        emit RiskClassChanged(token, CLASS_B, CLASS_A);
    }

    /// @notice Raising a cap is timelocked and limited to doubling per update.
    function proposeCapIncrease(address token, uint256 newCap) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (
            newCap <= config.maxTotalLocked || newCap > config.maxTotalLocked * MAX_CAP_GROWTH_FACTOR
                || newCap > type(uint128).max
        ) {
            revert OutOfBounds();
        }
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingCapIncrease[token] = PendingValue(newCap, eta);
        emit CapIncreaseProposed(token, config.maxTotalLocked, newCap, eta);
    }

    function cancelCapIncrease(address token) external onlyOwner {
        if (pendingCapIncrease[token].eta == 0) revert NothingPending();
        delete pendingCapIncrease[token];
        emit CapIncreaseCancelled(token);
    }

    function executeCapIncrease(address token) external {
        TokenConfig storage config = _listed(token);
        PendingValue memory pending = pendingCapIncrease[token];
        if (pending.eta == 0) revert NothingPending();
        if (block.timestamp < pending.eta) revert TimelockNotReady(pending.eta);
        if (pending.value <= config.maxTotalLocked || pending.value > config.maxTotalLocked * MAX_CAP_GROWTH_FACTOR) {
            revert OutOfBounds();
        }
        delete pendingCapIncrease[token];
        emit CapChanged(token, config.maxTotalLocked, pending.value);
        config.maxTotalLocked = pending.value;
    }

    /// @notice Immediate, risk-reducing only. A cap below the current total simply blocks new locks.
    function lowerCap(address token, uint256 newCap) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (newCap >= config.maxTotalLocked) revert OutOfBounds();
        emit CapChanged(token, config.maxTotalLocked, newCap);
        config.maxTotalLocked = newCap;
        delete pendingCapIncrease[token];
    }

    /// @notice Immediate, risk-reducing only. Existing positions are unaffected and can always exit.
    function disableLocks(address token) external onlyOwner {
        TokenConfig storage config = _listed(token);
        config.locksEnabled = false;
        delete pendingEnableLocks[token];
        emit LocksDisabled(token);
    }

    function proposeEnableLocks(address token) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (config.locksEnabled || config.releasedAt != 0) revert OutOfBounds();
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingEnableLocks[token] = eta;
        emit EnableLocksProposed(token, eta);
    }

    function cancelEnableLocks(address token) external onlyOwner {
        if (pendingEnableLocks[token] == 0) revert NothingPending();
        delete pendingEnableLocks[token];
        emit EnableLocksCancelled(token);
    }

    function executeEnableLocks(address token) external {
        TokenConfig storage config = _listed(token);
        uint64 eta = pendingEnableLocks[token];
        if (eta == 0) revert NothingPending();
        if (block.timestamp < eta) revert TimelockNotReady(eta);
        if (config.releasedAt != 0) revert OutOfBounds();
        delete pendingEnableLocks[token];
        config.locksEnabled = true;
        emit LocksEnabled(token);
    }

    // ------------------------------------------------------------------ positions

    /// @param termDays Must be 0 for Flexible; for Committed and Diamond 30 up to the class maximum
    ///        (90 days for Class A, 60 days for Class B). Diamond requires Class A.
    function lock(address token, uint256 amount, uint8 tier, uint256 termDays)
        external
        nonReentrant
        returns (uint256 positionId)
    {
        if (paused) revert IsPaused();
        TokenConfig storage config = _tokens[token];
        if (!config.listed) revert NotListed(token);
        if (!config.locksEnabled) revert LocksNotEnabled(token);
        if (tier > TIER_DIAMOND) revert InvalidTier();
        if (tier == TIER_DIAMOND && config.riskClass != CLASS_A) revert TierNotAllowed(tier);
        uint256 maxTerm = config.riskClass == CLASS_A ? MAX_TERM_DAYS : CLASS_B_MAX_TERM_DAYS;
        if (tier == TIER_FLEXIBLE ? termDays != 0 : (termDays < MIN_TERM_DAYS || termDays > maxTerm)) {
            revert InvalidTerm();
        }
        if (amount < config.unitAmount || amount > config.unitAmount * MAX_POSITION_UNITS) revert InvalidAmount();
        if (config.totalLocked + amount > config.maxTotalLocked) revert CapExceeded(token);

        positionId = nextPositionId++;
        uint64 startedAt = uint64(block.timestamp);
        uint64 endsAt = tier == TIER_FLEXIBLE ? startedAt : uint64(block.timestamp + termDays * 1 days);
        uint256 weight = (amount * tierMultiplierBps(tier)) / BPS;
        config.totalLocked += amount;
        config.totalWeight += weight;
        uint32 checkpoint = _writeCheckpoint(token, config.totalWeight);
        _positions[positionId] = Position({
            owner: msg.sender,
            tier: tier,
            startedAt: startedAt,
            endsAt: endsAt,
            closedAt: 0,
            token: token,
            startCheckpoint: checkpoint,
            endCheckpoint: 0,
            amount: amount,
            weight: weight
        });
        _positionsByOwner[msg.sender].push(positionId);

        _pullExact(token, msg.sender, amount);
        emit Locked(msg.sender, positionId, token, amount, weight, tier, startedAt, endsAt);
    }

    /// @param maxFeeBps The highest fee the caller accepts (protects against a stale quote).
    function exit(uint256 positionId, uint256 maxFeeBps) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.owner != msg.sender) revert NotPositionOwner();
        if (position.closedAt != 0) revert PositionClosed();

        (bool allowed, uint256 feeBps) = _exitTerms(position);
        if (!allowed) revert StillLocked();
        if (feeBps > maxFeeBps) revert FeeTooHigh(feeBps, maxFeeBps);

        address token = position.token;
        uint256 amount = position.amount;
        uint256 fee = (amount * feeBps) / BPS;

        // Effects: closedAt and endCheckpoint are written exactly once, here.
        TokenConfig storage config = _tokens[token];
        position.closedAt = uint64(block.timestamp);
        config.totalLocked -= amount;
        config.totalWeight -= position.weight;
        position.endCheckpoint = _writeCheckpoint(token, config.totalWeight);

        // Interactions.
        _push(token, msg.sender, amount - fee);
        bool burned = true;
        if (fee > 0) {
            burned = _tryPush(token, FEE_SINK, fee);
            if (!burned) retainedFees[token] += fee;
        }
        emit Exited(
            msg.sender, positionId, token, amount - fee, fee, burned, emergencyActivatedAt != 0 || config.releasedAt != 0
        );
    }

    // ------------------------------------------------------------------ views

    function positionOf(uint256 positionId) external view override returns (PositionView memory view_) {
        Position storage p = _positions[positionId];
        view_ = PositionView(
            p.owner, p.token, p.tier, p.startedAt, p.endsAt, p.closedAt, p.amount, p.weight, p.startCheckpoint,
            p.endCheckpoint
        );
    }

    function positionsOf(address account) external view returns (uint256[] memory) {
        return _positionsByOwner[account];
    }

    function tokenConfig(address token) external view returns (TokenConfig memory) {
        return _tokens[token];
    }

    function listedTokens() external view returns (address[] memory) {
        return _listedTokens;
    }

    function isListed(address token) external view override returns (bool) {
        return _tokens[token].listed;
    }

    function locksEnabled(address token) external view override returns (bool) {
        return _tokens[token].locksEnabled;
    }

    function unitAmount(address token) external view override returns (uint256) {
        return _tokens[token].unitAmount;
    }

    function riskClass(address token) external view returns (uint8) {
        return _tokens[token].riskClass;
    }

    function releasedAt(address token) external view override returns (uint64) {
        return _tokens[token].releasedAt;
    }

    /// @notice Tiers a user may choose for `token` right now, as a bitmask (bit i = tier i).
    function allowedTiers(address token) external view returns (uint8 mask, uint256 maxTermDays) {
        TokenConfig storage config = _tokens[token];
        if (!config.listed || !config.locksEnabled || paused) return (0, 0);
        return config.riskClass == CLASS_A ? (uint8(7), MAX_TERM_DAYS) : (uint8(3), CLASS_B_MAX_TERM_DAYS);
    }

    function checkpointCount(address token) external view override returns (uint256) {
        return _checkpoints[token].length;
    }

    function checkpointAt(address token, uint256 index)
        external
        view
        override
        returns (uint64 time, uint256 totalWeight)
    {
        Checkpoint storage c = _checkpoints[token][index];
        return (c.time, c.totalWeight);
    }

    function tierMultiplierBps(uint8 tier) public pure override returns (uint256) {
        if (tier == TIER_FLEXIBLE) return FLEXIBLE_MULTIPLIER_BPS;
        if (tier == TIER_COMMITTED) return COMMITTED_MULTIPLIER_BPS;
        if (tier == TIER_DIAMOND) return DIAMOND_MULTIPLIER_BPS;
        revert InvalidTier();
    }

    /// @notice Current exit terms for a position: whether it can exit now and at what fee.
    function exitTerms(uint256 positionId) external view returns (bool allowed, uint256 feeBps) {
        Position storage position = _positions[positionId];
        if (position.owner == address(0) || position.closedAt != 0) return (false, 0);
        return _exitTerms(position);
    }

    // ------------------------------------------------------------------ internals

    function _exitTerms(Position storage position) internal view returns (bool allowed, uint256 feeBps) {
        if (emergencyActivatedAt != 0 || _tokens[position.token].releasedAt != 0) return (true, 0);
        if (position.tier == TIER_FLEXIBLE || block.timestamp >= position.endsAt) return (true, 0);
        if (position.tier == TIER_DIAMOND) return (false, 0);
        uint256 duration = uint256(position.endsAt) - uint256(position.startedAt);
        uint256 remaining = uint256(position.endsAt) - block.timestamp;
        // Rounded up so the fee never reads zero while the term is still running.
        return (true, (COMMITTED_MAX_FEE_BPS * remaining + duration - 1) / duration);
    }

    function _list(address token, uint256 unitAmount_, uint256 maxTotalLocked_, uint8 riskClass_) internal {
        if (_tokens[token].listed) revert AlreadyListed(token);
        uint8 decimals = _validateToken(token, unitAmount_, maxTotalLocked_);
        _checkClass(riskClass_);
        _tokens[token] = TokenConfig({
            listed: true,
            locksEnabled: true,
            decimals: decimals,
            riskClass: riskClass_,
            lastUnitChange: uint64(block.timestamp),
            releasedAt: 0,
            unitAmount: unitAmount_,
            maxTotalLocked: maxTotalLocked_,
            totalLocked: 0,
            totalWeight: 0
        });
        _listedTokens.push(token);
        // Genesis checkpoint: reward integration for this token starts here with zero weight.
        _checkpoints[token].push(Checkpoint(uint64(block.timestamp), 0));
        emit Checkpointed(token, 0, uint64(block.timestamp), 0);
        emit TokenListed(token, decimals, unitAmount_, maxTotalLocked_, riskClass_);
    }

    /// @dev One checkpoint per (token, timestamp): several changes in one block collapse into the last value.
    ///      Readers must treat a checkpoint stamped with the current block timestamp as not yet final.
    function _writeCheckpoint(address token, uint256 totalWeight) internal returns (uint32 index) {
        Checkpoint[] storage cps = _checkpoints[token];
        uint256 n = cps.length;
        // totalWeight <= 2.5 x maxTotalLocked <= 2.5 x 2^128, so it always fits in uint192.
        if (cps[n - 1].time == uint64(block.timestamp)) {
            cps[n - 1].totalWeight = uint192(totalWeight);
            index = uint32(n - 1);
        } else {
            cps.push(Checkpoint(uint64(block.timestamp), uint192(totalWeight)));
            index = uint32(n);
        }
        emit Checkpointed(token, index, uint64(block.timestamp), totalWeight);
    }

    function _checkClass(uint8 riskClass_) internal pure {
        if (riskClass_ != CLASS_A && riskClass_ != CLASS_B) revert InvalidRiskClass();
    }

    function _validateToken(address token, uint256 unitAmount_, uint256 maxTotalLocked_)
        internal
        view
        returns (uint8 decimals)
    {
        if (token == address(0) || token.code.length == 0) revert InvalidToken(token);
        if (unitAmount_ == 0 || maxTotalLocked_ < unitAmount_ || maxTotalLocked_ > type(uint128).max) {
            revert InvalidAmount();
        }
        // Guard against overflow in unitAmount * MAX_POSITION_UNITS and in challenge scoring.
        if (unitAmount_ > type(uint128).max) revert InvalidAmount();
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length != 32) revert InvalidToken(token);
        uint256 raw = abi.decode(data, (uint256));
        if (raw < 6 || raw > 18) revert InvalidToken(token);
        decimals = uint8(raw);
    }

    function _listed(address token) internal view returns (TokenConfig storage config) {
        config = _tokens[token];
        if (!config.listed) revert NotListed(token);
    }

    function _checkUnitBounds(uint256 current, uint256 proposed) internal pure {
        if (proposed == 0 || proposed > type(uint128).max) revert OutOfBounds();
        if (proposed * BPS < current * UNIT_CHANGE_MIN_BPS || proposed * BPS > current * UNIT_CHANGE_MAX_BPS) {
            revert OutOfBounds();
        }
    }

    /// @dev Owner and guardian must be real contracts (Safes). An EIP-7702-delegated EOA has 23 bytes of "code"
    ///      (0xef0100 || delegate) but is still controlled by a single private key, so it is rejected too.
    function _requireContract(address account) internal view {
        if (account == address(0)) revert ZeroAddress();
        uint256 size = account.code.length;
        if (size == 0) revert NotContract(account);
        if (size == 23) {
            bytes memory c = account.code;
            if (c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00) revert NotContract(account);
        }
    }

    /// @dev Pulls exactly `amount`; rejects fee-on-transfer, rebasing-on-transfer and false-returning tokens.
    function _pullExact(address token, address from, uint256 amount) internal {
        uint256 before = _balanceOf(token);
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert TransferFailed(token);
        }
        if (_balanceOf(token) - before != amount) revert IncompatibleToken(token);
    }

    function _push(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!_tryPush(token, to, amount)) revert TransferFailed(token);
    }

    function _tryPush(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        return ok && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool))));
    }

    function _balanceOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || data.length != 32) revert IncompatibleToken(token);
        return abi.decode(data, (uint256));
    }
}
