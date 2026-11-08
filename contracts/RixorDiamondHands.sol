// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBurnableERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

/// @title RixorDiamondHands
/// @notice Conviction locks for a single burnable token ($WIF on Robinhood Chain).
///
/// Holders lock tokens for a term they choose. Breaking a lock before it ends costs a
/// paper-hands fee that starts at the term's maximum and declines linearly to zero at
/// unlock. Every fee is split in two:
///   - half is burned permanently through the token's own burn(), and
///   - half is streamed to everyone who is still locked, pro rata to lock weight.
/// Longer terms carry more weight, so the most patient holders earn the largest share.
///
/// There is no owner, no admin, no upgrade path and no protocol fee. Nothing in this
/// contract can move a holder's principal except that holder.
contract RixorDiamondHands {
    uint256 private constant BPS = 10_000;
    uint256 private constant ACC_PRECISION = 1e18;
    uint8 public constant TERM_COUNT = 5;

    struct Lock {
        address owner;
        uint8 term;
        uint64 startedAt;
        uint64 unlocksAt;
        bool open;
        uint256 amount;
        uint256 weight;
        uint256 rewardDebt;
    }

    IBurnableERC20 public immutable token;

    uint256 public nextLockId = 1;
    uint256 public totalLocked;
    uint256 public totalWeight;
    uint256 public totalBurned;
    uint256 public totalDistributed;
    uint256 public totalRewardsClaimed;
    uint256 public accRewardPerWeight;
    uint256 public openLocks;

    mapping(uint256 => Lock) public locks;
    mapping(address => uint256[]) private ownerLockIds;

    uint256 private reentrancyStatus = 1;

    event Locked(address indexed owner, uint256 indexed lockId, uint256 amount, uint8 term, uint256 weight, uint64 unlocksAt);
    event Unlocked(address indexed owner, uint256 indexed lockId, uint256 amount, uint256 reward);
    event LockBroken(
        address indexed owner,
        uint256 indexed lockId,
        uint256 amountReturned,
        uint256 fee,
        uint256 feeBps,
        uint256 burned,
        uint256 distributed,
        uint256 rewardForfeited
    );
    event RewardClaimed(address indexed owner, uint256 indexed lockId, uint256 reward);

    error ZeroAmount();
    error InvalidTerm();
    error NotLockOwner();
    error LockClosed();
    error StillLocked();
    error AlreadyUnlockable();
    error TransferFailed();
    error Reentrancy();

    constructor(address token_) {
        token = IBurnableERC20(token_);
    }

    modifier nonReentrant() {
        if (reentrancyStatus != 1) revert Reentrancy();
        reentrancyStatus = 2;
        _;
        reentrancyStatus = 1;
    }

    // ------------------------------------------------------------------ terms

    /// @notice Lock duration for each term: 7, 30, 90, 180 and 365 days.
    function termDuration(uint8 term) public pure returns (uint256) {
        if (term == 0) return 7 days;
        if (term == 1) return 30 days;
        if (term == 2) return 90 days;
        if (term == 3) return 180 days;
        if (term == 4) return 365 days;
        revert InvalidTerm();
    }

    /// @notice Maximum paper-hands fee in basis points: 5%, 10%, 15%, 20% and 25%.
    function termMaxFeeBps(uint8 term) public pure returns (uint256) {
        if (term == 0) return 500;
        if (term == 1) return 1_000;
        if (term == 2) return 1_500;
        if (term == 3) return 2_000;
        if (term == 4) return 2_500;
        revert InvalidTerm();
    }

    /// @notice Reward weight multiplier in basis points: 1x, 1.25x, 1.5x, 2x and 3x.
    function termWeightBps(uint8 term) public pure returns (uint256) {
        if (term == 0) return 10_000;
        if (term == 1) return 12_500;
        if (term == 2) return 15_000;
        if (term == 3) return 20_000;
        if (term == 4) return 30_000;
        revert InvalidTerm();
    }

    // ---------------------------------------------------------------- actions

    /// @notice Lock `amount` tokens for `term`. Requires a prior approve() to this contract.
    function lock(uint256 amount, uint8 term) external nonReentrant returns (uint256 lockId) {
        if (amount == 0) revert ZeroAmount();
        uint256 duration = termDuration(term);

        // Credit what actually arrived, so the contract stays solvent for any token.
        uint256 balanceBefore = token.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        uint256 weight = (received * termWeightBps(term)) / BPS;
        uint64 startedAt = uint64(block.timestamp);
        uint64 unlocksAt = uint64(block.timestamp + duration);

        lockId = nextLockId++;
        locks[lockId] = Lock({
            owner: msg.sender,
            term: term,
            startedAt: startedAt,
            unlocksAt: unlocksAt,
            open: true,
            amount: received,
            weight: weight,
            rewardDebt: (weight * accRewardPerWeight) / ACC_PRECISION
        });
        ownerLockIds[msg.sender].push(lockId);

        totalLocked += received;
        totalWeight += weight;
        openLocks += 1;

        emit Locked(msg.sender, lockId, received, term, weight, unlocksAt);
    }

    /// @notice Claim diamond-hand rewards earned so far without closing the lock.
    function claim(uint256 lockId) external nonReentrant returns (uint256 reward) {
        Lock storage position = _ownedOpenLock(lockId);
        reward = _pending(position);
        if (reward == 0) return 0;

        position.rewardDebt = (position.weight * accRewardPerWeight) / ACC_PRECISION;
        totalRewardsClaimed += reward;
        _safeTransfer(msg.sender, reward);

        emit RewardClaimed(msg.sender, lockId, reward);
    }

    /// @notice Close a lock that has reached its unlock time. No fee, rewards included.
    function unlock(uint256 lockId) external nonReentrant {
        Lock storage position = _ownedOpenLock(lockId);
        if (block.timestamp < position.unlocksAt) revert StillLocked();

        uint256 reward = _pending(position);
        uint256 amount = position.amount;
        _close(position);

        totalRewardsClaimed += reward;
        _safeTransfer(msg.sender, amount + reward);

        emit Unlocked(msg.sender, lockId, amount, reward);
    }

    /// @notice Break a lock early. Pays the current paper-hands fee and forfeits unclaimed
    ///         rewards; half the fee is burned and the rest goes to holders still locked.
    function breakLock(uint256 lockId) external nonReentrant {
        Lock storage position = _ownedOpenLock(lockId);
        if (block.timestamp >= position.unlocksAt) revert AlreadyUnlockable();

        uint256 feeBps = _currentFeeBps(position, block.timestamp);
        uint256 amount = position.amount;
        uint256 fee = (amount * feeBps) / BPS;
        uint256 forfeited = _pending(position);
        _close(position);

        uint256 burned = fee / 2;
        uint256 distributed = (fee - burned) + forfeited;

        // If nobody else is locked there is no one to pay, so everything is burned.
        if (totalWeight == 0) {
            burned += distributed;
            distributed = 0;
        } else {
            accRewardPerWeight += (distributed * ACC_PRECISION) / totalWeight;
            totalDistributed += distributed;
        }

        if (burned > 0) {
            totalBurned += burned;
            token.burn(burned);
        }

        uint256 amountReturned = amount - fee;
        _safeTransfer(msg.sender, amountReturned);

        emit LockBroken(msg.sender, lockId, amountReturned, fee, feeBps, burned, distributed, forfeited);
    }

    // ------------------------------------------------------------------ views

    function pendingReward(uint256 lockId) external view returns (uint256) {
        Lock storage position = locks[lockId];
        if (!position.open) return 0;
        return _pending(position);
    }

    /// @notice What breaking `lockId` right now would cost and return.
    function breakQuote(uint256 lockId)
        external
        view
        returns (uint256 feeBps, uint256 fee, uint256 amountReturned, uint256 rewardForfeited)
    {
        Lock storage position = locks[lockId];
        if (!position.open) revert LockClosed();
        feeBps = _currentFeeBps(position, block.timestamp);
        fee = (position.amount * feeBps) / BPS;
        amountReturned = position.amount - fee;
        rewardForfeited = _pending(position);
    }

    function getOwnerLockIds(address owner) external view returns (uint256[] memory) {
        return ownerLockIds[owner];
    }

    // -------------------------------------------------------------- internals

    function _ownedOpenLock(uint256 lockId) private view returns (Lock storage position) {
        position = locks[lockId];
        if (position.owner != msg.sender) revert NotLockOwner();
        if (!position.open) revert LockClosed();
    }

    function _pending(Lock storage position) private view returns (uint256) {
        return (position.weight * accRewardPerWeight) / ACC_PRECISION - position.rewardDebt;
    }

    function _close(Lock storage position) private {
        position.open = false;
        totalLocked -= position.amount;
        totalWeight -= position.weight;
        openLocks -= 1;
    }

    function _currentFeeBps(Lock storage position, uint256 timestamp) private view returns (uint256) {
        if (timestamp >= position.unlocksAt) return 0;
        uint256 duration = uint256(position.unlocksAt) - uint256(position.startedAt);
        uint256 remaining = uint256(position.unlocksAt) - timestamp;
        // Rounds up so the fee never reads 0 while the lock is still running.
        return (termMaxFeeBps(position.term) * remaining + duration - 1) / duration;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IBurnableERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IBurnableERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
