// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRixorLocker} from "./interfaces/IRixorLocker.sol";

/// @title RixorLocker
/// @notice Multi-token, time-based conviction locks for a curated allowlist of meme tokens.
///
/// Tiers (time only; no price oracle):
///   Flexible  0.5x  exit any time, no fee.
///   Committed 1.5x  30-90 day term; exiting early costs a fee of up to 10%, falling linearly to 0 at the end.
///   Diamond   2.5x  30-90 day term; no exit before the end of the term.
/// $WIF positions carry a 2.0x token multiplier, every other listed token 1.0x. Multipliers are constants.
///
/// Administration (owner = a Safe, required to be a contract):
///   - token listing, unit-size changes, cap increases and re-enabling locks are timelocked (48h) and bounded;
///   - lowering a cap or disabling new locks for a token is immediate (risk-reducing only).
/// Guardian (a Safe): may pause new activity (reversible by the owner) and activate an irreversible emergency
/// in which every position, including Diamond, can exit immediately with no fee.
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
    uint256 public constant WIF_MULTIPLIER_BPS = 20_000;
    uint256 public constant DEFAULT_TOKEN_MULTIPLIER_BPS = 10_000;

    uint256 public constant MIN_TERM_DAYS = 30;
    uint256 public constant MAX_TERM_DAYS = 90;
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
        uint64 lastUnitChange;
        uint256 unitAmount;
        uint256 maxTotalLocked;
        uint256 totalLocked;
    }

    struct Position {
        address owner;
        uint8 tier;
        uint64 startedAt;
        uint64 endsAt;
        uint64 closedAt;
        address token;
        uint256 amount;
    }

    struct PendingListing {
        uint256 unitAmount;
        uint256 maxTotalLocked;
        uint64 eta;
    }

    struct PendingValue {
        uint256 value;
        uint64 eta;
    }

    // ------------------------------------------------------------------ storage

    address public immutable override WIF;

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

    event TokenListed(address indexed token, uint8 decimals, uint256 unitAmount, uint256 maxTotalLocked);
    event ListingProposed(address indexed token, uint256 unitAmount, uint256 maxTotalLocked, uint64 eta);
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

    event Locked(
        address indexed owner,
        uint256 indexed positionId,
        address indexed token,
        uint256 amount,
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
        bool emergency
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

    /// @param wif_ The $WIF token. It must be among the initial tokens.
    /// @param owner_ Administrative Safe. Must be a contract; an EOA owner is rejected.
    /// @param guardian_ Emergency Safe. Must be a contract.
    /// @param tokens Initial allowlist (exact addresses). Public at deployment, so not timelocked.
    /// @param unitAmounts Unit size per token (token base units per scoring unit).
    /// @param maxTotalLocked Per-token cap on total locked principal (token base units).
    constructor(
        address wif_,
        address owner_,
        address guardian_,
        address[] memory tokens,
        uint256[] memory unitAmounts,
        uint256[] memory maxTotalLocked
    ) {
        if (wif_ == address(0)) revert ZeroAddress();
        _requireContract(owner_);
        _requireContract(guardian_);
        if (tokens.length == 0 || tokens.length != unitAmounts.length || tokens.length != maxTotalLocked.length) {
            revert InvalidAmount();
        }
        WIF = wif_;
        owner = owner_;
        guardian = guardian_;
        emit OwnershipTransferred(address(0), owner_);
        emit GuardianChanged(address(0), guardian_);

        bool wifListed;
        for (uint256 i = 0; i < tokens.length; i++) {
            _list(tokens[i], unitAmounts[i], maxTotalLocked[i]);
            if (tokens[i] == wif_) wifListed = true;
        }
        if (!wifListed) revert InvalidToken(wif_);
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
    ///         at this moment become refund-only (enforced by RixorChallenges). New activity stops for good.
    function activateEmergency() external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        if (emergencyActivatedAt != 0) revert EmergencyActive();
        emergencyActivatedAt = uint64(block.timestamp);
        paused = true;
        emit EmergencyActivated(msg.sender, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------ token registry (timelocked)

    function proposeListing(address token, uint256 unitAmount_, uint256 maxTotalLocked_) external onlyOwner {
        if (_tokens[token].listed) revert AlreadyListed(token);
        _validateToken(token, unitAmount_, maxTotalLocked_);
        uint64 eta = uint64(block.timestamp + TIMELOCK_DELAY);
        pendingListing[token] = PendingListing(unitAmount_, maxTotalLocked_, eta);
        emit ListingProposed(token, unitAmount_, maxTotalLocked_, eta);
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
        _list(token, pending.unitAmount, pending.maxTotalLocked);
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

    /// @notice Raising a cap is timelocked and limited to doubling per update.
    function proposeCapIncrease(address token, uint256 newCap) external onlyOwner {
        TokenConfig storage config = _listed(token);
        if (newCap <= config.maxTotalLocked || newCap > config.maxTotalLocked * MAX_CAP_GROWTH_FACTOR) {
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
        if (config.locksEnabled) revert OutOfBounds();
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
        delete pendingEnableLocks[token];
        config.locksEnabled = true;
        emit LocksEnabled(token);
    }

    // ------------------------------------------------------------------ positions

    /// @param termDays Must be 0 for Flexible, 30-90 for Committed and Diamond.
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
        if (tier == TIER_FLEXIBLE ? termDays != 0 : (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS)) {
            revert InvalidTerm();
        }
        if (amount < config.unitAmount || amount > config.unitAmount * MAX_POSITION_UNITS) revert InvalidAmount();
        if (config.totalLocked + amount > config.maxTotalLocked) revert CapExceeded(token);

        positionId = nextPositionId++;
        uint64 startedAt = uint64(block.timestamp);
        uint64 endsAt = tier == TIER_FLEXIBLE ? startedAt : uint64(block.timestamp + termDays * 1 days);
        _positions[positionId] = Position({
            owner: msg.sender,
            tier: tier,
            startedAt: startedAt,
            endsAt: endsAt,
            closedAt: 0,
            token: token,
            amount: amount
        });
        _positionsByOwner[msg.sender].push(positionId);
        config.totalLocked += amount;

        _pullExact(token, msg.sender, amount);
        emit Locked(msg.sender, positionId, token, amount, tier, startedAt, endsAt);
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

        // Effects: closedAt is written exactly once, here.
        position.closedAt = uint64(block.timestamp);
        _tokens[token].totalLocked -= amount;

        // Interactions.
        _push(token, msg.sender, amount - fee);
        bool burned = true;
        if (fee > 0) {
            burned = _tryPush(token, FEE_SINK, fee);
            if (!burned) retainedFees[token] += fee;
        }
        emit Exited(msg.sender, positionId, token, amount - fee, fee, burned, emergencyActivatedAt != 0);
    }

    // ------------------------------------------------------------------ views

    function positionOf(uint256 positionId) external view override returns (PositionView memory view_) {
        Position storage p = _positions[positionId];
        view_ = PositionView(p.owner, p.token, p.tier, p.startedAt, p.endsAt, p.closedAt, p.amount);
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

    function tierMultiplierBps(uint8 tier) public pure override returns (uint256) {
        if (tier == TIER_FLEXIBLE) return FLEXIBLE_MULTIPLIER_BPS;
        if (tier == TIER_COMMITTED) return COMMITTED_MULTIPLIER_BPS;
        if (tier == TIER_DIAMOND) return DIAMOND_MULTIPLIER_BPS;
        revert InvalidTier();
    }

    function tokenMultiplierBps(address token) external view override returns (uint256) {
        return token == WIF ? WIF_MULTIPLIER_BPS : DEFAULT_TOKEN_MULTIPLIER_BPS;
    }

    /// @notice Current exit terms for a position: whether it can exit now and at what fee.
    function exitTerms(uint256 positionId) external view returns (bool allowed, uint256 feeBps) {
        Position storage position = _positions[positionId];
        if (position.owner == address(0) || position.closedAt != 0) return (false, 0);
        return _exitTerms(position);
    }

    // ------------------------------------------------------------------ internals

    function _exitTerms(Position storage position) internal view returns (bool allowed, uint256 feeBps) {
        if (emergencyActivatedAt != 0) return (true, 0);
        if (position.tier == TIER_FLEXIBLE || block.timestamp >= position.endsAt) return (true, 0);
        if (position.tier == TIER_DIAMOND) return (false, 0);
        uint256 duration = uint256(position.endsAt) - uint256(position.startedAt);
        uint256 remaining = uint256(position.endsAt) - block.timestamp;
        // Rounded up so the fee never reads zero while the term is still running.
        return (true, (COMMITTED_MAX_FEE_BPS * remaining + duration - 1) / duration);
    }

    function _list(address token, uint256 unitAmount_, uint256 maxTotalLocked_) internal {
        if (_tokens[token].listed) revert AlreadyListed(token);
        uint8 decimals = _validateToken(token, unitAmount_, maxTotalLocked_);
        _tokens[token] = TokenConfig({
            listed: true,
            locksEnabled: true,
            decimals: decimals,
            lastUnitChange: uint64(block.timestamp),
            unitAmount: unitAmount_,
            maxTotalLocked: maxTotalLocked_,
            totalLocked: 0
        });
        _listedTokens.push(token);
        emit TokenListed(token, decimals, unitAmount_, maxTotalLocked_);
    }

    function _validateToken(address token, uint256 unitAmount_, uint256 maxTotalLocked_)
        internal
        view
        returns (uint8 decimals)
    {
        if (token == address(0) || token.code.length == 0) revert InvalidToken(token);
        if (unitAmount_ == 0 || maxTotalLocked_ < unitAmount_) revert InvalidAmount();
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

    function _requireContract(address account) internal view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotContract(account);
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
