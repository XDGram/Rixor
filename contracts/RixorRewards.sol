// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRixorLocker} from "./interfaces/IRixorLocker.sol";

/// @title RixorRewards
/// @notice Prefunded $WIF reward streams for positions locked in RixorLocker.
///
/// - Anyone may fund a stream for a listed token: at least MIN_FUNDING WIF over MIN_DAYS-MAX_DAYS whole days.
///   A stream starts at the next UTC midnight and pays `rate = floor(amount / seconds)` WIF per second, shared
///   by that token's open positions in proportion to their weight (amount x tier multiplier).
/// - There is no cap on concurrent streams: a stream only adds a rate change at its start day and end day.
/// - The Locker is read-only from here. Its per-token weight checkpoints are integrated lazily, in bounded,
///   permissionless batches (`sync`). The Locker never calls this contract, so exits never depend on it.
/// - Time during which a token has zero locked weight earns nothing; each stream's share of that time is
///   refundable to the stream's funder, together with the rounding remainder of `amount / seconds`.
/// - Accrual for a token stops at the Locker's global emergency or at that token's release, whichever is
///   first. The unstreamed remainder of every affected stream is refundable to its funder.
///
/// There is no owner and no admin function: nobody can withdraw funded WIF other than through claims by
/// position owners and refunds to funders.
contract RixorRewards {
    uint256 public constant DAY = 1 days;
    /// @dev Accumulator precision. 1e36 keeps per-interval rounding loss below one wei of WIF per 1e36 weight.
    uint256 public constant ACC = 1e36;
    uint256 public constant MIN_FUNDING = 10_000 ether;
    uint256 public constant MAX_FUNDING = type(uint128).max;
    uint256 public constant MIN_DAYS = 7;
    uint256 public constant MAX_DAYS = 90;

    struct Pool {
        uint32 cursor; // next Locker checkpoint index to integrate
        uint64 lastTime; // integrated up to here; 0 = not initialised
        bool stopRecorded; // zeroAtStop has been written
        uint256 weight; // total weight in force since lastTime
        uint256 rate; // WIF wei per second in force since lastTime
        uint256 acc; // reward per weight, scaled by ACC
        uint256 zero; // cumulative seconds with zero weight while accrual was live
        uint256 zeroAtStop;
    }

    struct Stream {
        address funder;
        address token;
        uint64 startDay;
        uint64 endDay;
        bool refunded;
        uint256 rate;
        uint256 amount;
    }

    IRixorLocker public immutable locker;
    address public immutable wif;

    mapping(address token => Pool) public pools;
    mapping(address token => mapping(uint256 day => int256)) public rateDelta;
    mapping(address token => mapping(uint256 day => uint256)) public zeroAtDay;
    mapping(address token => mapping(uint256 index => uint256)) public accAtCheckpoint;
    mapping(uint256 positionId => uint256) public claimedOf;
    Stream[] internal _streams;

    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public totalRefunded;

    uint256 private _reentrancy = 1;

    event StreamFunded(
        uint256 indexed streamId,
        address indexed token,
        address indexed funder,
        uint256 amount,
        uint256 rate,
        uint64 startTime,
        uint64 endTime
    );
    event Synced(address indexed token, uint64 integratedTo, uint32 cursor, bool caughtUp);
    event Claimed(address indexed account, uint256 indexed positionId, uint256 amount);
    event Refunded(uint256 indexed streamId, address indexed funder, uint256 amount);

    error Reentrancy();
    error InvalidParams();
    error NotListed(address token);
    error TokenStopped(address token);
    error InvalidAmount();
    error InvalidDuration();
    error NeedsSync(address token);
    error NotPositionOwner(uint256 positionId);
    error NotReady();
    error AlreadyRefunded();
    error TransferFailed();
    error IncompatibleToken();

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    constructor(IRixorLocker locker_, address wif_) {
        if (address(locker_).code.length == 0 || wif_.code.length == 0) revert InvalidParams();
        if (locker_.isListed(wif_)) revert InvalidParams(); // the reward token must not double as a locked asset
        locker = locker_;
        wif = wif_;
    }

    // ------------------------------------------------------------------ funding

    /// @notice Fund a stream for `token`: `amount` WIF over `days_` whole days from the next UTC midnight.
    function fund(address token, uint256 amount, uint256 days_) external nonReentrant returns (uint256 streamId) {
        if (!locker.isListed(token)) revert NotListed(token);
        if (stopTime(token) != 0) revert TokenStopped(token);
        if (amount < MIN_FUNDING || amount > MAX_FUNDING) revert InvalidAmount();
        if (days_ < MIN_DAYS || days_ > MAX_DAYS) revert InvalidDuration();
        Pool storage p = _init(token);
        uint256 startDay = (block.timestamp + DAY - 1) / DAY; // next UTC midnight, or now if exactly on one
        if (startDay * DAY <= p.lastTime) startDay += 1; // that boundary has already been integrated
        uint256 rate = amount / (days_ * DAY);
        rateDelta[token][startDay] += int256(rate);
        rateDelta[token][startDay + days_] -= int256(rate);
        streamId = _streams.length;
        _streams.push(
            Stream({
                funder: msg.sender,
                token: token,
                startDay: uint64(startDay),
                endDay: uint64(startDay + days_),
                refunded: false,
                rate: rate,
                amount: amount
            })
        );
        totalFunded += amount;
        _pullExact(msg.sender, amount);
        emit StreamFunded(
            streamId, token, msg.sender, amount, rate, uint64(startDay * DAY), uint64((startDay + days_) * DAY)
        );
    }

    // ------------------------------------------------------------------ integration (bounded, permissionless)

    /// @notice Timestamp at which accrual for `token` stops for good (emergency or release), or 0.
    function stopTime(address token) public view returns (uint256) {
        uint256 em = locker.emergencyActivatedAt();
        uint256 rel = locker.releasedAt(token);
        if (em == 0) return rel;
        if (rel == 0) return em;
        return em < rel ? em : rel;
    }

    /// @notice Integrate `token` up to min(now, stopTime) in at most `maxSteps` steps. Returns true when caught up.
    function sync(address token, uint256 maxSteps) public returns (bool caughtUp) {
        if (!locker.isListed(token)) revert NotListed(token);
        Pool storage p = _init(token);
        uint256 stop = stopTime(token);
        uint256 cap = stop != 0 && stop < block.timestamp ? stop : block.timestamp;
        uint256 n = locker.checkpointCount(token);
        for (uint256 steps; steps < maxSteps; steps++) {
            if (_step(token, p, cap, n, stop)) {
                caughtUp = true;
                break;
            }
        }
        emit Synced(token, p.lastTime, p.cursor, caughtUp);
    }

    function _init(address token) internal returns (Pool storage p) {
        p = pools[token];
        if (p.lastTime == 0) {
            // Start at the genesis checkpoint with zero weight; checkpoints themselves are processed by _step.
            (uint64 t0,) = locker.checkpointAt(token, 0);
            p.lastTime = t0;
        }
    }

    /// @dev Advance to the next checkpoint, UTC day boundary or cap, whichever is first. Returns true when there
    ///      is nothing left to do up to `cap`.
    function _step(address token, Pool storage p, uint256 cap, uint256 n, uint256 stop) internal returns (bool) {
        // A checkpoint stamped with the current block timestamp can still change in this block, so it is only
        // processed in a later block.
        uint256 nextCp = type(uint256).max;
        if (p.cursor < n) {
            (uint64 t,) = locker.checkpointAt(token, p.cursor);
            if (t < block.timestamp) nextCp = t;
        }
        uint256 nextDay = (uint256(p.lastTime) / DAY + 1) * DAY;
        uint256 t_ = nextCp < nextDay ? nextCp : nextDay;
        if (t_ > cap) t_ = cap;
        if (t_ > p.lastTime) {
            uint256 dt = t_ - p.lastTime;
            if (p.weight > 0) p.acc += (p.rate * dt * ACC) / p.weight;
            else p.zero += dt;
            p.lastTime = uint64(t_);
        }
        bool progressed = false;
        if (t_ == nextDay) {
            int256 d = rateDelta[token][t_ / DAY];
            if (d != 0) p.rate = uint256(int256(p.rate) + d);
            zeroAtDay[token][t_ / DAY] = p.zero;
            progressed = true;
        }
        if (t_ == nextCp) {
            (, uint256 w) = locker.checkpointAt(token, p.cursor);
            p.weight = w;
            accAtCheckpoint[token][p.cursor] = p.acc;
            p.cursor++;
            progressed = true;
        }
        if (stop != 0 && t_ == stop && !p.stopRecorded) {
            p.zeroAtStop = p.zero;
            p.stopRecorded = true;
        }
        return !progressed && t_ == cap;
    }

    // ------------------------------------------------------------------ claims

    /// @notice Total WIF a position has earned so far, and whether the token is integrated far enough to know.
    function earned(uint256 positionId) public view returns (uint256 total, bool ready) {
        IRixorLocker.PositionView memory pos = locker.positionOf(positionId);
        if (pos.owner == address(0)) return (0, true);
        Pool storage p = pools[pos.token];
        if (p.cursor <= pos.startCheckpoint) return (0, false);
        uint256 accStart = accAtCheckpoint[pos.token][pos.startCheckpoint];
        uint256 stop = stopTime(pos.token);
        uint256 accEnd;
        if (pos.closedAt != 0 && (stop == 0 || pos.closedAt < stop)) {
            if (p.cursor <= pos.endCheckpoint) return (0, false);
            accEnd = accAtCheckpoint[pos.token][pos.endCheckpoint];
        } else {
            // Open, or closed at/after the stop: earns up to min(now, stop).
            uint256 cap = stop != 0 && stop < block.timestamp ? stop : block.timestamp;
            if (p.lastTime < cap) return (0, false);
            accEnd = p.acc;
        }
        return ((pos.weight * (accEnd - accStart)) / ACC, true);
    }

    /// @notice WIF claimable now for `positionId` (0 if the token still needs a sync).
    function claimable(uint256 positionId) external view returns (uint256) {
        (uint256 total, bool ready) = earned(positionId);
        return ready ? total - claimedOf[positionId] : 0;
    }

    /// @notice Claim accrued WIF for positions owned by the caller. Syncs each position's token by up to
    ///         `maxSteps` steps first; reverts with NeedsSync if that is not enough (nothing is lost).
    function claim(uint256[] calldata positionIds, uint256 maxSteps) external nonReentrant returns (uint256 paid) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            IRixorLocker.PositionView memory pos = locker.positionOf(id);
            if (pos.owner != msg.sender) revert NotPositionOwner(id);
            sync(pos.token, maxSteps);
            (uint256 total, bool ready) = earned(id);
            if (!ready) revert NeedsSync(pos.token);
            uint256 due = total - claimedOf[id];
            if (due == 0) continue;
            claimedOf[id] = total;
            paid += due;
            emit Claimed(msg.sender, id, due);
        }
        totalClaimed += paid;
        _push(msg.sender, paid);
    }

    // ------------------------------------------------------------------ refunds to funders

    /// @notice WIF returnable to a stream's funder (unallocated + unstreamed + rounding remainder), and whether
    ///         that amount is final.
    function refundable(uint256 streamId) public view returns (uint256 amount, bool ready) {
        Stream storage s = _streams[streamId];
        Pool storage p = pools[s.token];
        uint256 startT = uint256(s.startDay) * DAY;
        uint256 endT = uint256(s.endDay) * DAY;
        uint256 dust = s.amount - s.rate * (endT - startT);
        uint256 stop = stopTime(s.token);
        if (stop != 0 && stop < endT) {
            if (!p.stopRecorded) return (0, false);
            uint256 unallocated = stop > startT ? s.rate * (p.zeroAtStop - zeroAtDay[s.token][s.startDay]) : 0;
            uint256 unstreamed = s.rate * (endT - (stop > startT ? stop : startT));
            return (unallocated + unstreamed + dust, true);
        }
        if (p.lastTime < endT) return (0, false);
        return (s.rate * (zeroAtDay[s.token][s.endDay] - zeroAtDay[s.token][s.startDay]) + dust, true);
    }

    /// @notice Return a finished (or stopped) stream's refundable WIF to its funder. Anyone may call.
    function refund(uint256 streamId, uint256 maxSteps) external nonReentrant returns (uint256 amount) {
        Stream storage s = _streams[streamId];
        if (s.refunded) revert AlreadyRefunded();
        sync(s.token, maxSteps);
        bool ready;
        (amount, ready) = refundable(streamId);
        if (!ready) revert NotReady();
        s.refunded = true;
        totalRefunded += amount;
        _push(s.funder, amount);
        emit Refunded(streamId, s.funder, amount);
    }

    // ------------------------------------------------------------------ views

    function streamCount() external view returns (uint256) {
        return _streams.length;
    }

    function streamOf(uint256 streamId) external view returns (Stream memory) {
        return _streams[streamId];
    }

    /// @notice Current WIF per second being streamed to `token` (as of the last integration).
    function currentRate(address token) external view returns (uint256) {
        return pools[token].rate;
    }

    // ------------------------------------------------------------------ token transfers

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
