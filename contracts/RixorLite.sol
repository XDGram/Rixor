// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Lite {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title RixorLite
/// @notice Lock ONE token, earn $WIF. The smallest version of Rixor: one contract, one lockable token, one reward
///         budget paid from a separate reward wallet.
///
/// - Anyone locks `token`. Each lock (or top-up) starts a fixed lock period of `lockSeconds`; after it, `exit()`
///   returns the whole locked amount.
/// - From deployment until `endTime`, `rate` WIF per second is shared by everyone locked, in proportion to the
///   amount locked. Seconds in which nothing is locked earn nothing for anyone.
/// - Rewards are NOT held here. `claim()` moves WIF from `rewardWallet` straight to the claimer, using the allowance
///   that wallet gave this contract. If the reward wallet has no WIF or no allowance left, `claim()` reverts and the
///   unclaimed amount stays recorded. The reward wallet can therefore stop funding rewards, but it can never touch a
///   locked token.
/// - `exit()` never calls the reward token or the reward wallet, so nothing about rewards can block a withdrawal.
///
/// There is no owner, no admin, no pause, no upgrade path and no fee. Every parameter is immutable. The only way a
/// locked token leaves this contract is `exit()` called by the account that locked it. Tested, not audited.
contract RixorLite {
    /// @dev Precision of the reward accumulator (reward per locked token-wei, scaled).
    uint256 internal constant ACC = 1e27;
    uint256 public constant MIN_DURATION = 1 days;
    uint256 public constant MAX_DURATION = 90 days;
    uint256 public constant MAX_LOCK_SECONDS = 30 days;

    struct Account {
        uint256 amount; // tokens locked
        uint256 accPaid; // accPerToken at the last settlement
        uint256 owed; // rewards settled but not yet claimed
        uint64 unlockAt; // exit is allowed from this time
    }

    address public immutable token;
    address public immutable wif;
    address public immutable rewardWallet;
    /// @notice WIF wei per second shared by all lockers while at least one token is locked.
    uint256 public immutable rate;
    uint256 public immutable budget;
    uint256 public immutable startTime;
    uint256 public immutable endTime;
    uint256 public immutable lockSeconds;
    uint256 public immutable minLock;
    /// @notice Most tokens this contract will ever hold at once (limits what is at risk in unaudited code).
    uint256 public immutable cap;

    uint256 public totalLocked;
    uint256 public totalClaimed;
    uint256 public accPerToken;
    uint256 public lastUpdate;
    mapping(address account => Account) public accounts;

    uint256 private _entered = 1;

    event Locked(address indexed account, uint256 amount, uint256 totalForAccount, uint256 unlockAt);
    event Exited(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    error InvalidParams();
    error InvalidAmount();
    error CapExceeded();
    error RewardsEnded();
    error StillLocked(uint256 unlockAt);
    error NothingLocked();
    error NothingToClaim();
    error TransferFailed();
    error IncompatibleToken();
    error Reentrancy();

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @param budget_ Total WIF the reward wallet commits; `rate = budget_ / duration_` (rounded down).
    constructor(
        address token_,
        address wif_,
        address rewardWallet_,
        uint256 budget_,
        uint256 duration_,
        uint256 lockSeconds_,
        uint256 minLock_,
        uint256 cap_
    ) {
        if (token_.code.length == 0 || wif_.code.length == 0 || token_ == wif_) revert InvalidParams();
        if (rewardWallet_ == address(0) || rewardWallet_ == address(this)) revert InvalidParams();
        if (duration_ < MIN_DURATION || duration_ > MAX_DURATION || lockSeconds_ > MAX_LOCK_SECONDS) revert InvalidParams();
        if (minLock_ == 0 || cap_ < minLock_ || cap_ > type(uint128).max || budget_ > type(uint128).max) revert InvalidParams();
        // `amount * (accPerToken - accPaid)` can never overflow: accPerToken <= budget * ACC / minLock, amount <= cap.
        if ((budget_ * ACC) / minLock_ > type(uint256).max / cap_) revert InvalidParams();
        uint256 rate_ = budget_ / duration_;
        if (rate_ == 0) revert InvalidParams();
        token = token_;
        wif = wif_;
        rewardWallet = rewardWallet_;
        budget = budget_;
        rate = rate_;
        startTime = block.timestamp;
        endTime = block.timestamp + duration_;
        lockSeconds = lockSeconds_;
        minLock = minLock_;
        cap = cap_;
        lastUpdate = block.timestamp;
    }

    // ------------------------------------------------------------------ lock / exit / claim

    /// @notice Lock `amount` of the token (approve this contract first). A top-up restarts the lock period for the
    ///         whole balance.
    function lock(uint256 amount) external nonReentrant {
        if (block.timestamp >= endTime) revert RewardsEnded();
        _accrue();
        Account storage a = accounts[msg.sender];
        _settle(a);
        uint256 total = a.amount + amount;
        if (amount == 0 || total < minLock) revert InvalidAmount();
        if (totalLocked + amount > cap) revert CapExceeded();
        a.amount = total;
        a.unlockAt = uint64(block.timestamp + lockSeconds);
        totalLocked += amount;

        // The token must deliver exactly `amount` (no transfer fee, no rebasing).
        uint256 before = IERC20Lite(token).balanceOf(address(this));
        _call(token, abi.encodeCall(IERC20Lite.transferFrom, (msg.sender, address(this), amount)));
        if (IERC20Lite(token).balanceOf(address(this)) != before + amount) revert IncompatibleToken();
        emit Locked(msg.sender, amount, total, a.unlockAt);
    }

    /// @notice Withdraw everything you locked, once your lock period has passed. Unclaimed WIF stays claimable.
    ///         This function never touches the reward token or the reward wallet.
    function exit() external nonReentrant {
        Account storage a = accounts[msg.sender];
        uint256 amount = a.amount;
        if (amount == 0) revert NothingLocked();
        if (block.timestamp < a.unlockAt) revert StillLocked(a.unlockAt);
        _accrue();
        _settle(a);
        a.amount = 0;
        totalLocked -= amount;
        _call(token, abi.encodeCall(IERC20Lite.transfer, (msg.sender, amount)));
        emit Exited(msg.sender, amount);
    }

    /// @notice Claim the WIF you have earned. It is sent from the reward wallet to you.
    function claim() external nonReentrant returns (uint256 paid) {
        _accrue();
        Account storage a = accounts[msg.sender];
        _settle(a);
        paid = a.owed;
        if (paid == 0) revert NothingToClaim();
        a.owed = 0;
        totalClaimed += paid;
        _call(wif, abi.encodeCall(IERC20Lite.transferFrom, (rewardWallet, msg.sender, paid)));
        emit Claimed(msg.sender, paid);
    }

    // ------------------------------------------------------------------ views

    /// @notice WIF `account` could claim right now (if the reward wallet is funded).
    function earned(address account) external view returns (uint256) {
        Account storage a = accounts[account];
        return a.owed + (a.amount * (_accNow() - a.accPaid)) / ACC;
    }

    /// @notice WIF the reward wallet can pay through this contract right now: min(its balance, its allowance).
    function rewardsAvailable() external view returns (uint256) {
        uint256 bal = IERC20Lite(wif).balanceOf(rewardWallet);
        uint256 allowed = IERC20Lite(wif).allowance(rewardWallet, address(this));
        return bal < allowed ? bal : allowed;
    }

    // ------------------------------------------------------------------ internals

    function _accNow() internal view returns (uint256 acc) {
        acc = accPerToken;
        uint256 until = block.timestamp < endTime ? block.timestamp : endTime;
        if (until > lastUpdate && totalLocked > 0) acc += ((until - lastUpdate) * rate * ACC) / totalLocked;
    }

    function _accrue() internal {
        accPerToken = _accNow();
        uint256 until = block.timestamp < endTime ? block.timestamp : endTime;
        if (until > lastUpdate) lastUpdate = until;
    }

    /// @dev Rounds down at every step, so the sum of everything ever owed can never exceed rate x elapsed time
    ///      (and therefore never the budget the reward wallet approved).
    function _settle(Account storage a) internal {
        uint256 acc = accPerToken;
        if (a.amount != 0) a.owed += (a.amount * (acc - a.accPaid)) / ACC;
        a.accPaid = acc;
    }

    /// @dev ERC-20 call that accepts both "returns true" and "returns nothing", and reverts on failure.
    function _call(address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
