// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRixorLocker} from "./interfaces/IRixorLocker.sol";

/// @title RixorChallenges
/// @notice Community and Season challenges paid in $WIF from prefunded, per-challenge escrow.
///
/// - A challenge escrows its full WIF pool at creation; anyone may add more (co-sponsor) before it ends.
///   Every payout is debited from that challenge's own escrow, so one challenge can never use another's funds.
/// - Holders join with an open RixorLocker position. Points are computed at join from a scoring table frozen
///   when the challenge was created:  points = units x tierMultiplier x tokenMultiplier / 10_000, where
///   units = min(amount / unitSnapshot, 10) and units must be >= the challenge's minimum.
///   Points are relative scoring units for splitting this challenge's pool. They are not USD values.
/// - Lanes: a position can be in at most one community challenge and one Season challenge at a time.
/// - Qualification is retroactive and deterministic: a participant qualifies if the Locker's write-once
///   closedAt is 0 or >= endTime. Settlement may only run strictly after endTime.
/// - Successful challenges pay pro-rata claims for 30 days; the remainder returns pro-rata to sponsors.
///   Failed challenges and challenges cancelled by an emergency refund each sponsor's own contribution.
///
/// There is no admin function that can move escrow. The only privileged action is creating a Season
/// challenge, restricted to the Locker owner (a Safe) and funded by the caller.
contract RixorChallenges {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_UNITS = 10;
    uint256 public constant MAX_PARTICIPANTS = 200;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant CLAIM_WINDOW = 30 days;
    uint256 public constant MAX_COMMUNITY_TOKENS = 2;
    uint256 public constant MAX_SEASON_TOKENS = 8;
    uint256 public constant MIN_CREATE_POOL = 100_000 ether;
    uint256 public constant MIN_SPONSOR_AMOUNT = 10_000 ether;
    uint256 public constant MAX_POOL = 10_000_000 ether;
    uint256 public constant MIN_HOLD_LOWER_BOUND = 1 hours;
    uint256 public constant MIN_HOLD_UPPER_BOUND = 7 days;
    uint256 public constant MAX_TITLE_BYTES = 80;
    uint256 public constant MAX_DESCRIPTION_BYTES = 2_000;

    struct CreateParams {
        address[] tokens;
        uint8 minTier;
        uint8 minUnitsPerEntry;
        uint64 joinDeadline;
        uint64 endTime;
        uint256 goalPoints;
        uint16 maxParticipants;
        string title;
        string description;
    }

    struct Challenge {
        address creator;
        bool isSeason;
        uint8 minTier;
        uint8 minUnitsPerEntry;
        uint16 maxParticipants;
        uint64 joinDeadline;
        uint64 endTime;
        uint64 claimDeadline;
        bool settled;
        bool success;
        bool sweepSnapshotTaken;
        uint32 participantCount;
        uint32 settleCursor;
        uint32 qualifiedCount;
        uint256 goalPoints;
        uint256 pool;
        uint256 escrow;
        uint256 joinedPoints;
        uint256 qualifiedPoints;
        uint256 claimedTotal;
        uint256 refundedTotal;
        uint256 sweptTotal;
        uint256 sweepPool;
        string title;
    }

    struct Entry {
        uint256 positionId;
        uint256 points;
        bool qualified;
        bool claimed;
    }

    IRixorLocker public immutable locker;
    address public immutable wif;
    /// @notice Minimum holding window between the join deadline and the end. Fixed at deployment
    ///         (24 hours for production; shorter only for explicitly configured demo deployments).
    uint256 public immutable minHold;

    uint256 public nextChallengeId = 1;
    /// @notice Sum of every challenge's escrow. The contract's WIF balance always covers it.
    uint256 public totalEscrow;

    mapping(uint256 id => Challenge) internal _challenges;
    mapping(uint256 id => address[]) internal _tokens;
    mapping(uint256 id => mapping(address token => uint256)) public unitSnapshot;
    mapping(uint256 id => mapping(address token => uint256)) public tokenMultiplierSnapshot;
    mapping(uint256 id => address[]) internal _participants;
    mapping(uint256 id => mapping(address account => Entry)) internal _entries;
    mapping(uint256 id => mapping(address sponsor => uint256)) public contributionOf;
    mapping(uint256 id => mapping(address sponsor => bool)) public refunded;
    mapping(uint256 id => mapping(address sponsor => bool)) public swept;

    /// @notice Lane occupancy: the challenge a position is currently committed to in each lane.
    mapping(uint256 positionId => uint256 challengeId) public communityLane;
    mapping(uint256 positionId => uint256 challengeId) public seasonLane;

    uint256 private _reentrancy = 1;

    event ChallengeCreated(
        uint256 indexed id, address indexed creator, bool isSeason, uint256 pool, string title, string description
    );
    event ChallengeRules(
        uint256 indexed id,
        address[] tokens,
        uint256[] unitSnapshots,
        uint8 minTier,
        uint8 minUnitsPerEntry,
        uint64 joinDeadline,
        uint64 endTime,
        uint256 goalPoints,
        uint16 maxParticipants
    );
    event Sponsored(uint256 indexed id, address indexed sponsor, uint256 amount, uint256 newPool);
    event Joined(
        uint256 indexed id, address indexed participant, uint256 indexed positionId, uint256 points, address referrer
    );
    event SettlementProgress(uint256 indexed id, uint32 processed, uint32 total);
    event Settled(
        uint256 indexed id, bool success, uint256 qualifiedPoints, uint32 qualifiedCount, uint64 claimDeadline
    );
    event Claimed(uint256 indexed id, address indexed participant, uint256 amount);
    event Refunded(uint256 indexed id, address indexed sponsor, uint256 amount, bool cancelled);
    event Swept(uint256 indexed id, address indexed sponsor, uint256 amount);

    error Reentrancy();
    error NotLockerOwner();
    error IsPaused();
    error EmergencyActive();
    error InvalidParams();
    error InvalidToken(address token);
    error InvalidTiming();
    error InvalidAmount();
    error ChallengeNotFound();
    error JoinClosed();
    error ChallengeEnded();
    error NotPositionOwner();
    error PositionClosed();
    error TokenNotAllowed();
    error TierTooLow();
    error PositionEndsTooEarly();
    error BelowMinimumUnits();
    error AlreadyJoined();
    error LaneOccupied(uint256 challengeId);
    error ChallengeFull();
    error NotEnded();
    error Cancelled();
    error AlreadySettled();
    error NotSettled();
    error NotSuccessful();
    error NotQualified();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error NotRefundable();
    error NothingToRefund();
    error AlreadyRefunded();
    error NothingToSweep();
    error AlreadySwept();
    error TransferFailed();
    error IncompatibleToken();

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    constructor(IRixorLocker locker_, uint256 minHold_) {
        if (address(locker_).code.length == 0) revert InvalidParams();
        if (minHold_ < MIN_HOLD_LOWER_BOUND || minHold_ > MIN_HOLD_UPPER_BOUND) revert InvalidParams();
        locker = locker_;
        wif = locker_.WIF();
        minHold = minHold_;
    }

    // ------------------------------------------------------------------ creation and sponsorship

    /// @notice Create a community challenge: one listed token, optionally plus $WIF as the second token.
    function createChallenge(CreateParams calldata params, uint256 amount) external nonReentrant returns (uint256) {
        uint256 count = params.tokens.length;
        if (count == 0 || count > MAX_COMMUNITY_TOKENS) revert InvalidParams();
        if (count == 2 && (params.tokens[1] != wif || params.tokens[0] == wif)) revert InvalidParams();
        return _create(params, amount, false);
    }

    /// @notice Create a Season challenge (stackable with one community challenge). Locker owner only.
    function createSeason(CreateParams calldata params, uint256 amount) external nonReentrant returns (uint256) {
        if (msg.sender != locker.owner()) revert NotLockerOwner();
        uint256 count = params.tokens.length;
        if (count == 0 || count > MAX_SEASON_TOKENS) revert InvalidParams();
        return _create(params, amount, true);
    }

    function sponsor(uint256 id, uint256 amount) external nonReentrant {
        Challenge storage c = _get(id);
        _requireActiveProtocol();
        if (block.timestamp >= c.endTime) revert ChallengeEnded();
        if (amount < MIN_SPONSOR_AMOUNT || c.pool + amount > MAX_POOL) revert InvalidAmount();
        c.pool += amount;
        c.escrow += amount;
        contributionOf[id][msg.sender] += amount;
        totalEscrow += amount;
        _pullExact(msg.sender, amount);
        emit Sponsored(id, msg.sender, amount, c.pool);
    }

    // ------------------------------------------------------------------ participation

    function join(uint256 id, uint256 positionId, address referrer) external nonReentrant {
        Challenge storage c = _get(id);
        _requireActiveProtocol();
        if (block.timestamp > c.joinDeadline) revert JoinClosed();
        if (_entries[id][msg.sender].positionId != 0) revert AlreadyJoined();
        if (c.participantCount >= c.maxParticipants) revert ChallengeFull();

        IRixorLocker.PositionView memory p = locker.positionOf(positionId);
        if (p.owner != msg.sender) revert NotPositionOwner();
        if (p.closedAt != 0) revert PositionClosed();
        uint256 unit = unitSnapshot[id][p.token];
        if (unit == 0) revert TokenNotAllowed();
        if (p.tier < c.minTier) revert TierTooLow();
        if (p.tier != 0 && p.endsAt < c.endTime) revert PositionEndsTooEarly();

        mapping(uint256 => uint256) storage lane = c.isSeason ? seasonLane : communityLane;
        uint256 occupied = lane[positionId];
        if (occupied != 0 && _challenges[occupied].endTime > block.timestamp) revert LaneOccupied(occupied);

        uint256 units = p.amount / unit;
        if (units > MAX_UNITS) units = MAX_UNITS;
        if (units == 0 || units < c.minUnitsPerEntry) revert BelowMinimumUnits();
        uint256 points = units * locker.tierMultiplierBps(p.tier) * tokenMultiplierSnapshot[id][p.token] / BPS;

        lane[positionId] = id;
        _entries[id][msg.sender] = Entry({positionId: positionId, points: points, qualified: false, claimed: false});
        _participants[id].push(msg.sender);
        c.participantCount += 1;
        c.joinedPoints += points;
        emit Joined(id, msg.sender, positionId, points, referrer);
    }

    // ------------------------------------------------------------------ settlement

    /// @notice Process up to `maxItems` participants. Anyone may call. Only strictly after endTime.
    function settle(uint256 id, uint256 maxItems) external nonReentrant {
        Challenge storage c = _get(id);
        if (c.settled) revert AlreadySettled();
        if (_isCancelled(c)) revert Cancelled();
        if (block.timestamp <= c.endTime) revert NotEnded();
        if (maxItems == 0) revert InvalidParams();

        address[] storage list = _participants[id];
        uint256 total = list.length;
        uint256 cursor = c.settleCursor;
        uint256 stop = cursor + maxItems > total ? total : cursor + maxItems;
        for (; cursor < stop; cursor++) {
            Entry storage entry = _entries[id][list[cursor]];
            uint64 closedAt = locker.positionOf(entry.positionId).closedAt;
            if (closedAt == 0 || closedAt >= c.endTime) {
                entry.qualified = true;
                c.qualifiedPoints += entry.points;
                c.qualifiedCount += 1;
            }
        }
        c.settleCursor = uint32(cursor);
        emit SettlementProgress(id, uint32(cursor), uint32(total));

        if (cursor == total) {
            c.settled = true;
            c.success = c.qualifiedPoints > 0 && c.qualifiedPoints >= c.goalPoints;
            c.claimDeadline = uint64(block.timestamp + CLAIM_WINDOW);
            emit Settled(id, c.success, c.qualifiedPoints, c.qualifiedCount, c.claimDeadline);
        }
    }

    // ------------------------------------------------------------------ payouts

    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Challenge storage c = _get(id);
        if (!c.settled) revert NotSettled();
        if (!c.success) revert NotSuccessful();
        if (block.timestamp > c.claimDeadline) revert ClaimWindowClosed();
        Entry storage entry = _entries[id][msg.sender];
        if (!entry.qualified) revert NotQualified();
        if (entry.claimed) revert AlreadyClaimed();

        amount = c.pool * entry.points / c.qualifiedPoints;
        entry.claimed = true;
        c.claimedTotal += amount;
        c.escrow -= amount;
        totalEscrow -= amount;
        _push(msg.sender, amount);
        emit Claimed(id, msg.sender, amount);
    }

    /// @notice Return a sponsor's own contribution from a failed or emergency-cancelled challenge.
    function refund(uint256 id) external nonReentrant returns (uint256 amount) {
        Challenge storage c = _get(id);
        bool cancelled = _isCancelled(c);
        if (!cancelled && !(c.settled && !c.success)) revert NotRefundable();
        amount = contributionOf[id][msg.sender];
        if (amount == 0) revert NothingToRefund();
        if (refunded[id][msg.sender]) revert AlreadyRefunded();

        refunded[id][msg.sender] = true;
        c.refundedTotal += amount;
        c.escrow -= amount;
        totalEscrow -= amount;
        _push(msg.sender, amount);
        emit Refunded(id, msg.sender, amount, cancelled);
    }

    /// @notice After the claim window, unclaimed rewards and rounding dust return to sponsors pro-rata.
    function sweep(uint256 id) external nonReentrant returns (uint256 amount) {
        Challenge storage c = _get(id);
        if (!c.settled || !c.success) revert NotSettled();
        if (block.timestamp <= c.claimDeadline) revert ClaimWindowOpen();
        uint256 contribution = contributionOf[id][msg.sender];
        if (contribution == 0) revert NothingToSweep();
        if (swept[id][msg.sender]) revert AlreadySwept();
        if (!c.sweepSnapshotTaken) {
            c.sweepSnapshotTaken = true;
            c.sweepPool = c.escrow;
        }
        amount = c.sweepPool * contribution / c.pool;
        swept[id][msg.sender] = true;
        c.sweptTotal += amount;
        c.escrow -= amount;
        totalEscrow -= amount;
        _push(msg.sender, amount);
        emit Swept(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function getChallenge(uint256 id) external view returns (Challenge memory) {
        return _challenges[id];
    }

    function challengeTokens(uint256 id) external view returns (address[] memory) {
        return _tokens[id];
    }

    function participants(uint256 id, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        address[] storage all = _participants[id];
        if (offset >= all.length) return new address[](0);
        uint256 end = offset + limit > all.length ? all.length : offset + limit;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    function entryOf(uint256 id, address account) external view returns (Entry memory) {
        return _entries[id][account];
    }

    function isCancelled(uint256 id) external view returns (bool) {
        return _isCancelled(_challenges[id]);
    }

    /// @notice What `account` could claim right now (0 if not eligible).
    function claimable(uint256 id, address account) external view returns (uint256) {
        Challenge storage c = _challenges[id];
        Entry storage entry = _entries[id][account];
        if (!c.settled || !c.success || entry.claimed || !entry.qualified || block.timestamp > c.claimDeadline) {
            return 0;
        }
        return c.pool * entry.points / c.qualifiedPoints;
    }

    /// @notice Points a position would score in a challenge (0 if it cannot join). Does not check lanes.
    function previewPoints(uint256 id, uint256 positionId) external view returns (uint256) {
        IRixorLocker.PositionView memory p = locker.positionOf(positionId);
        uint256 unit = unitSnapshot[id][p.token];
        if (unit == 0 || p.closedAt != 0) return 0;
        uint256 units = p.amount / unit;
        if (units > MAX_UNITS) units = MAX_UNITS;
        if (units == 0 || units < _challenges[id].minUnitsPerEntry) return 0;
        return units * locker.tierMultiplierBps(p.tier) * tokenMultiplierSnapshot[id][p.token] / BPS;
    }

    // ------------------------------------------------------------------ internals

    function _create(CreateParams calldata params, uint256 amount, bool isSeason) internal returns (uint256 id) {
        _requireActiveProtocol();
        if (params.minTier > 2) revert InvalidParams();
        if (params.minUnitsPerEntry == 0 || params.minUnitsPerEntry > MAX_UNITS) revert InvalidParams();
        if (params.maxParticipants == 0 || params.maxParticipants > MAX_PARTICIPANTS) revert InvalidParams();
        if (bytes(params.title).length == 0 || bytes(params.title).length > MAX_TITLE_BYTES) revert InvalidParams();
        if (bytes(params.description).length > MAX_DESCRIPTION_BYTES) revert InvalidParams();
        if (params.joinDeadline <= block.timestamp) revert InvalidTiming();
        if (uint256(params.joinDeadline) + minHold > params.endTime) revert InvalidTiming();
        if (params.endTime > block.timestamp + MAX_DURATION) revert InvalidTiming();
        if (amount < MIN_CREATE_POOL || amount > MAX_POOL) revert InvalidAmount();

        id = nextChallengeId++;
        Challenge storage c = _challenges[id];
        c.creator = msg.sender;
        c.isSeason = isSeason;
        c.minTier = params.minTier;
        c.minUnitsPerEntry = params.minUnitsPerEntry;
        c.maxParticipants = params.maxParticipants;
        c.joinDeadline = params.joinDeadline;
        c.endTime = params.endTime;
        c.goalPoints = params.goalPoints;
        c.pool = amount;
        c.escrow = amount;
        c.title = params.title;

        uint256[] memory units = new uint256[](params.tokens.length);
        for (uint256 i = 0; i < params.tokens.length; i++) {
            address token = params.tokens[i];
            if (!locker.isListed(token) || !locker.locksEnabled(token)) revert InvalidToken(token);
            if (unitSnapshot[id][token] != 0) revert InvalidToken(token); // duplicate
            uint256 unit = locker.unitAmount(token);
            unitSnapshot[id][token] = unit;
            tokenMultiplierSnapshot[id][token] = locker.tokenMultiplierBps(token);
            _tokens[id].push(token);
            units[i] = unit;
        }

        contributionOf[id][msg.sender] = amount;
        totalEscrow += amount;
        _pullExact(msg.sender, amount);

        emit ChallengeCreated(id, msg.sender, isSeason, amount, params.title, params.description);
        emit ChallengeRules(
            id,
            params.tokens,
            units,
            params.minTier,
            params.minUnitsPerEntry,
            params.joinDeadline,
            params.endTime,
            params.goalPoints,
            params.maxParticipants
        );
    }

    function _get(uint256 id) internal view returns (Challenge storage c) {
        c = _challenges[id];
        if (c.creator == address(0)) revert ChallengeNotFound();
    }

    /// @dev A challenge still running when the Locker's emergency was activated is cancelled (refund-only).
    function _isCancelled(Challenge storage c) internal view returns (bool) {
        uint64 emergencyAt = locker.emergencyActivatedAt();
        return emergencyAt != 0 && c.endTime > emergencyAt && !c.settled;
    }

    function _requireActiveProtocol() internal view {
        if (locker.emergencyActivatedAt() != 0) revert EmergencyActive();
        if (locker.paused()) revert IsPaused();
    }

    function _pullExact(address from, uint256 amount) internal {
        uint256 before = _balance();
        (bool ok, bytes memory data) =
            wif.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TransferFailed();
        if (_balance() - before != amount) revert IncompatibleToken();
    }

    function _push(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = wif.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TransferFailed();
    }

    function _balance() internal view returns (uint256) {
        (bool ok, bytes memory data) = wif.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || data.length != 32) revert IncompatibleToken();
        return abi.decode(data, (uint256));
    }
}
