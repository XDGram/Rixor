// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RixorLite} from "../contracts/RixorLite.sol";
import {MockERC20, FeeOnTransferToken, FalseReturnToken, NoReturnToken, ReentrantToken} from "./utils/Mocks.sol";

/// @dev Reverts on every call: stands in for a reward token or reward wallet that has gone wrong.
contract AlwaysReverts {
    fallback() external payable {
        revert("broken");
    }
}

contract RixorLiteTest is Test {
    RixorLite internal lite;
    MockERC20 internal meme;
    MockERC20 internal wif;
    address internal rewardWallet = makeAddr("reward-wallet");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant BUDGET = 1_000 ether;
    uint256 internal constant DURATION = 7 days;
    uint256 internal constant LOCK = 1 days;
    uint256 internal constant MIN = 10 ether;
    uint256 internal constant CAP = 100_000 ether;
    uint256 internal rate;

    function setUp() public {
        vm.warp(1_800_000_000);
        meme = new MockERC20("Meme", "MEME", 18);
        wif = new MockERC20("Reward stand-in", "tWIF", 18);
        lite = new RixorLite(address(meme), address(wif), rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        rate = lite.rate();
        wif.mint(rewardWallet, BUDGET);
        vm.prank(rewardWallet);
        wif.approve(address(lite), BUDGET);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            meme.mint(who, 1_000_000 ether);
            vm.prank(who);
            meme.approve(address(lite), type(uint256).max);
        }
    }

    function _amount(address who) internal view returns (uint256 amount) {
        (amount,,,) = lite.accounts(who);
    }

    // ------------------------------------------------------------------ constructor

    function test_parameters() public view {
        assertEq(lite.token(), address(meme));
        assertEq(lite.wif(), address(wif));
        assertEq(lite.rewardWallet(), rewardWallet);
        assertEq(lite.budget(), BUDGET);
        assertEq(lite.rate(), BUDGET / DURATION);
        assertEq(lite.endTime() - lite.startTime(), DURATION);
        assertEq(lite.lockSeconds(), LOCK);
        assertEq(lite.minLock(), MIN);
        assertEq(lite.cap(), CAP);
        assertEq(lite.rewardsAvailable(), BUDGET);
    }

    function test_constructor_rejectsBadParameters() public {
        address m = address(meme);
        address w = address(wif);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(alice, w, rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP); // token is not a contract
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, alice, rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP); // reward token is not a contract
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, m, rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP); // the reward token cannot be locked
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, address(0), BUDGET, DURATION, LOCK, MIN, CAP);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, BUDGET, 1 days - 1, LOCK, MIN, CAP);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, BUDGET, 90 days + 1, LOCK, MIN, CAP);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, BUDGET, DURATION, 30 days + 1, MIN, CAP);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, BUDGET, DURATION, LOCK, 0, CAP);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, BUDGET, DURATION, LOCK, MIN, MIN - 1);
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, DURATION - 1, DURATION, LOCK, MIN, CAP); // rate would be zero
        vm.expectRevert(RixorLite.InvalidParams.selector);
        new RixorLite(m, w, rewardWallet, type(uint128).max, DURATION, LOCK, 1, type(uint128).max); // could overflow
    }

    // ------------------------------------------------------------------ lock

    function test_lock_pullsExactlyAndStartsTheLockPeriod() public {
        vm.prank(alice);
        lite.lock(50 ether);
        assertEq(meme.balanceOf(address(lite)), 50 ether);
        assertEq(lite.totalLocked(), 50 ether);
        (uint256 amount,,, uint64 unlockAt) = lite.accounts(alice);
        assertEq(amount, 50 ether);
        assertEq(unlockAt, block.timestamp + LOCK);
    }

    function test_lock_rejectsZeroBelowMinimumAndAboveCap() public {
        vm.startPrank(alice);
        vm.expectRevert(RixorLite.InvalidAmount.selector);
        lite.lock(0);
        vm.expectRevert(RixorLite.InvalidAmount.selector);
        lite.lock(MIN - 1);
        vm.expectRevert(RixorLite.CapExceeded.selector);
        lite.lock(CAP + 1);
        lite.lock(CAP);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(RixorLite.CapExceeded.selector);
        lite.lock(MIN);
    }

    function test_lock_topUpRestartsTheLockPeriodAndKeepsRewards() public {
        vm.prank(alice);
        lite.lock(100 ether);
        skip(12 hours);
        uint256 before = lite.earned(alice);
        vm.prank(alice);
        lite.lock(1 ether); // a top-up may be below the minimum
        (uint256 amount,,, uint64 unlockAt) = lite.accounts(alice);
        assertEq(amount, 101 ether);
        assertEq(unlockAt, block.timestamp + LOCK);
        assertEq(lite.earned(alice), before, "top-up keeps what was earned");
    }

    function test_lock_closedAfterRewardsEnd() public {
        skip(DURATION);
        vm.prank(alice);
        vm.expectRevert(RixorLite.RewardsEnded.selector);
        lite.lock(50 ether);
    }

    function test_lock_rejectsFeeOnTransferAndFalseReturnTokens() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        RixorLite a = new RixorLite(address(fee), address(wif), rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        fee.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        fee.approve(address(a), type(uint256).max);
        vm.expectRevert(RixorLite.IncompatibleToken.selector);
        a.lock(100 ether);
        vm.stopPrank();

        FalseReturnToken bad = new FalseReturnToken();
        RixorLite b = new RixorLite(address(bad), address(wif), rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        bad.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        bad.approve(address(b), type(uint256).max);
        vm.expectRevert(RixorLite.TransferFailed.selector);
        b.lock(100 ether);
        vm.stopPrank();
    }

    function test_lock_and_exit_workWithTokensThatReturnNothing() public {
        NoReturnToken t = new NoReturnToken();
        RixorLite c = new RixorLite(address(t), address(wif), rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        t.mint(alice, 100 ether);
        vm.startPrank(alice);
        t.approve(address(c), 100 ether);
        c.lock(100 ether);
        skip(LOCK);
        c.exit();
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 100 ether);
    }

    // ------------------------------------------------------------------ rewards

    function test_rewards_soleLockerEarnsTheFullRate() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(1 hours);
        assertApproxEqAbs(lite.earned(alice), rate * 1 hours, 1);
    }

    function test_rewards_sharedInProportionToAmountLocked() public {
        vm.prank(alice);
        lite.lock(300 ether);
        vm.prank(bob);
        lite.lock(100 ether);
        skip(1 days);
        assertApproxEqAbs(lite.earned(alice), (rate * 1 days * 3) / 4, 2);
        assertApproxEqAbs(lite.earned(bob), (rate * 1 days) / 4, 2);
    }

    function test_rewards_noAccrualWhileNothingIsLocked() public {
        skip(2 days); // nobody locked
        vm.prank(alice);
        lite.lock(50 ether);
        assertEq(lite.earned(alice), 0);
        skip(1 hours);
        assertApproxEqAbs(lite.earned(alice), rate * 1 hours, 1, "only the time actually locked counts");
    }

    function test_rewards_stopAtTheEnd() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(DURATION + 30 days);
        assertApproxEqAbs(lite.earned(alice), rate * DURATION, 1);
        assertLe(lite.earned(alice), BUDGET);
    }

    function test_claim_movesWifFromTheRewardWalletToTheClaimer() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(1 hours);
        uint256 due = lite.earned(alice);
        vm.expectEmit(true, false, false, true);
        emit RixorLite.Claimed(alice, due);
        vm.prank(alice);
        uint256 paid = lite.claim();
        assertEq(paid, due);
        assertEq(wif.balanceOf(alice), due);
        assertEq(wif.balanceOf(rewardWallet), BUDGET - due);
        assertEq(wif.balanceOf(address(lite)), 0, "the contract never holds WIF");
        assertEq(wif.allowance(rewardWallet, address(lite)), BUDGET - due);
        assertEq(lite.totalClaimed(), due);
        assertEq(lite.earned(alice), 0);
    }

    function test_claim_revertsWithNothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert(RixorLite.NothingToClaim.selector);
        lite.claim();
    }

    function test_claim_failsCleanlyWhenTheRewardWalletStopsFunding_thenWorksAgain() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(1 hours);
        uint256 due = lite.earned(alice);
        vm.prank(rewardWallet);
        wif.approve(address(lite), 0);
        assertEq(lite.rewardsAvailable(), 0);
        vm.prank(alice);
        vm.expectRevert(RixorLite.TransferFailed.selector);
        lite.claim();
        assertEq(lite.earned(alice), due, "nothing is lost by a failed claim");
        vm.prank(rewardWallet);
        wif.approve(address(lite), BUDGET);
        vm.prank(alice);
        assertEq(lite.claim(), due);
    }

    function test_claim_afterExit() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(LOCK);
        vm.prank(alice);
        lite.exit();
        uint256 due = lite.earned(alice);
        assertApproxEqAbs(due, rate * LOCK, 1);
        skip(3 days);
        assertEq(lite.earned(alice), due, "no accrual after exit");
        vm.prank(alice);
        assertEq(lite.claim(), due);
    }

    // ------------------------------------------------------------------ exit

    function test_exit_blockedUntilTheLockPeriodEnds() public {
        vm.prank(alice);
        lite.lock(50 ether);
        skip(LOCK - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorLite.StillLocked.selector, block.timestamp + 1));
        lite.exit();
        skip(1);
        uint256 before = meme.balanceOf(alice);
        vm.prank(alice);
        lite.exit();
        assertEq(meme.balanceOf(alice), before + 50 ether);
        assertEq(lite.totalLocked(), 0);
        assertEq(meme.balanceOf(address(lite)), 0);
    }

    function test_exit_revertsWithNothingLocked() public {
        vm.prank(alice);
        vm.expectRevert(RixorLite.NothingLocked.selector);
        lite.exit();
    }

    function test_exit_onlyReturnsTheCallersOwnTokens() public {
        vm.prank(alice);
        lite.lock(50 ether);
        vm.prank(bob);
        lite.lock(70 ether);
        skip(LOCK);
        uint256 before = meme.balanceOf(bob);
        vm.prank(bob);
        lite.exit();
        assertEq(meme.balanceOf(bob), before + 70 ether);
        assertEq(meme.balanceOf(address(lite)), 50 ether, "alice's tokens stay");
        assertEq(_amount(alice), 50 ether);
    }

    /// @dev The reward token and reward wallet can be completely broken: exits still return every token.
    function test_exit_neverDependsOnTheRewardTokenOrWallet() public {
        AlwaysReverts brokenWif = new AlwaysReverts();
        RixorLite c = new RixorLite(address(meme), address(brokenWif), rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        vm.startPrank(alice);
        meme.approve(address(c), 50 ether);
        c.lock(50 ether);
        skip(LOCK);
        vm.expectRevert(RixorLite.TransferFailed.selector);
        c.claim();
        uint256 before = meme.balanceOf(alice);
        c.exit();
        vm.stopPrank();
        assertEq(meme.balanceOf(alice), before + 50 ether);
    }

    function test_exit_worksAfterRewardsEndAndAfterTheWalletIsEmptied() public {
        vm.prank(alice);
        lite.lock(50 ether);
        vm.startPrank(rewardWallet);
        wif.approve(address(lite), 0);
        wif.transfer(bob, BUDGET);
        vm.stopPrank();
        skip(DURATION + 1 days);
        uint256 before = meme.balanceOf(alice);
        vm.prank(alice);
        lite.exit();
        assertEq(meme.balanceOf(alice), before + 50 ether);
    }

    function test_reentrancyIsBlocked() public {
        ReentrantToken t = new ReentrantToken();
        RixorLite c = new RixorLite(address(t), address(wif), rewardWallet, BUDGET, DURATION, 0, MIN, CAP);
        t.mint(alice, 100 ether);
        vm.startPrank(alice);
        t.approve(address(c), type(uint256).max);
        c.lock(50 ether);
        t.arm(address(c), abi.encodeCall(RixorLite.exit, ()));
        c.lock(10 ether); // the token calls exit() during the transfer
        vm.stopPrank();
        assertTrue(t.reentered());
        assertFalse(t.lastCallSucceeded(), "re-entry must fail");
        assertEq(c.totalLocked(), 60 ether);
        assertEq(t.balanceOf(address(c)), 60 ether);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Whatever two lockers do, rewards never exceed rate x time, and each exit returns exactly the principal.
    function testFuzz_conservation(uint96 a1, uint96 b1, uint32 t1, uint32 t2, uint32 t3, bool bobExits) public {
        uint256 la = bound(a1, MIN, CAP / 2);
        uint256 lb = bound(b1, MIN, CAP / 2);
        uint256 start = block.timestamp;
        vm.prank(alice);
        lite.lock(la);
        skip(bound(t1, 0, 3 days));
        vm.prank(bob);
        lite.lock(lb);
        skip(bound(t2, LOCK, 3 days));
        if (bobExits) {
            uint256 before = meme.balanceOf(bob);
            vm.prank(bob);
            lite.exit();
            assertEq(meme.balanceOf(bob), before + lb);
        }
        skip(bound(t3, 0, 10 days));
        uint256 elapsed = (block.timestamp < lite.endTime() ? block.timestamp : lite.endTime()) - start;
        uint256 total = lite.earned(alice) + lite.earned(bob);
        assertLe(total, rate * elapsed, "never more than rate x time");
        assertGe(total + 4, rate * elapsed, "and nothing but rounding dust is lost while someone is locked");
        assertLe(total, BUDGET);
        uint256 beforeA = meme.balanceOf(alice);
        vm.prank(alice);
        lite.exit();
        assertEq(meme.balanceOf(alice), beforeA + la);
        assertEq(meme.balanceOf(address(lite)), bobExits ? 0 : lb);
    }
}

// ---------------------------------------------------------------------- invariants

contract LiteHandler is Test {
    RixorLite public lite;
    MockERC20 public meme;
    MockERC20 public wif;
    address public rewardWallet;
    address[] public actors;
    uint256 public exits;
    uint256 public claims;
    uint256 public failedClaims;

    constructor(RixorLite lite_, MockERC20 meme_, MockERC20 wif_, address rewardWallet_) {
        lite = lite_;
        meme = meme_;
        wif = wif_;
        rewardWallet = rewardWallet_;
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            actors.push(a);
            meme.mint(a, 1_000_000 ether);
            vm.prank(a);
            meme.approve(address(lite), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function lock(uint256 who, uint256 amount) external {
        if (block.timestamp >= lite.endTime()) return;
        address a = actors[who % actors.length];
        uint256 room = lite.cap() - lite.totalLocked();
        if (room < lite.minLock()) return;
        amount = bound(amount, lite.minLock(), room > 20_000 ether ? 20_000 ether : room);
        vm.prank(a);
        lite.lock(amount);
    }

    /// @dev An exit after the lock period must NEVER revert, whatever the reward wallet has done.
    function exit(uint256 who) external {
        address a = actors[who % actors.length];
        (uint256 amount,,, uint64 unlockAt) = lite.accounts(a);
        if (amount == 0 || block.timestamp < unlockAt) return;
        uint256 before = meme.balanceOf(a);
        vm.prank(a);
        lite.exit();
        assertEq(meme.balanceOf(a), before + amount, "exit returns exactly the principal");
        exits++;
    }

    function claim(uint256 who) external {
        address a = actors[who % actors.length];
        uint256 due = lite.earned(a);
        if (due == 0) return;
        uint256 before = wif.balanceOf(a);
        vm.prank(a);
        try lite.claim() returns (uint256 paid) {
            assertEq(paid, due);
            assertEq(wif.balanceOf(a), before + due);
            claims++;
        } catch {
            assertLt(lite.rewardsAvailable(), due, "a claim only fails when the reward wallet cannot pay");
            assertEq(lite.earned(a), due, "a failed claim loses nothing");
            failedClaims++;
        }
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 1, 2 days));
    }

    /// @dev The reward wallet revokes or restores its allowance at will.
    function toggleFunding(bool on) external {
        vm.prank(rewardWallet);
        wif.approve(address(lite), on ? lite.budget() - lite.totalClaimed() : 0);
    }
}

contract RixorLiteInvariants is Test {
    RixorLite internal lite;
    MockERC20 internal meme;
    MockERC20 internal wif;
    LiteHandler internal handler;
    address internal rewardWallet = makeAddr("reward-wallet");
    uint256 internal constant BUDGET = 1_000 ether;

    function setUp() public {
        vm.warp(1_800_000_000);
        meme = new MockERC20("Meme", "MEME", 18);
        wif = new MockERC20("Reward stand-in", "tWIF", 18);
        lite = new RixorLite(address(meme), address(wif), rewardWallet, BUDGET, 7 days, 1 days, 10 ether, 100_000 ether);
        wif.mint(rewardWallet, BUDGET);
        vm.prank(rewardWallet);
        wif.approve(address(lite), BUDGET);
        handler = new LiteHandler(lite, meme, wif, rewardWallet);
        targetContract(address(handler));
    }

    /// @dev The contract holds exactly what users locked, and it never holds the reward token.
    function invariant_custodyIsExact() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            (uint256 amount,,,) = lite.accounts(handler.actors(i));
            sum += amount;
        }
        assertEq(sum, lite.totalLocked());
        assertEq(meme.balanceOf(address(lite)), lite.totalLocked());
        assertLe(lite.totalLocked(), lite.cap());
        assertEq(wif.balanceOf(address(lite)), 0);
    }

    /// @dev Claimed + claimable never exceeds rate x elapsed time, hence never the budget.
    function invariant_rewardsAreBounded() public view {
        uint256 until = block.timestamp < lite.endTime() ? block.timestamp : lite.endTime();
        uint256 outstanding;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            outstanding += lite.earned(handler.actors(i));
        }
        assertLe(lite.totalClaimed() + outstanding, lite.rate() * (until - lite.startTime()));
        assertLe(lite.totalClaimed() + outstanding, BUDGET);
        assertEq(wif.balanceOf(rewardWallet), BUDGET - lite.totalClaimed(), "WIF only ever leaves the reward wallet as claims");
    }
}
