// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RixorBase} from "./utils/RixorBase.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {
    MockERC20,
    MockSafe,
    FeeOnTransferToken,
    FalseReturnToken,
    NoReturnToken,
    BlocksDeadToken,
    ReentrantToken,
    BadDecimalsToken
} from "./utils/Mocks.sol";

contract RixorLockerTest is RixorBase {
    // ------------------------------------------------------------------ construction and roles

    function _deploy(address owner_, address guardian_, address token, uint256 unit, uint256 cap)
        internal
        returns (RixorLocker)
    {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256[] memory units = new uint256[](1);
        units[0] = unit;
        uint256[] memory caps = new uint256[](1);
        caps[0] = cap;
        return new RixorLocker(address(wif), owner_, guardian_, tokens, units, caps);
    }

    function test_constructor_rejectsEoaOwner() public {
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.NotContract.selector, alice));
        _deploy(alice, address(guardianSafe), address(wif), WIF_UNIT, WIF_CAP);
    }

    function test_constructor_rejectsEoaGuardian() public {
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.NotContract.selector, alice));
        _deploy(address(ownerSafe), alice, address(wif), WIF_UNIT, WIF_CAP);
    }

    function test_constructor_requiresWifListed() public {
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.InvalidToken.selector, address(wif)));
        _deploy(address(ownerSafe), address(guardianSafe), address(dope), DOPE_UNIT, DOPE_CAP);
    }

    function test_constructor_rejectsBadDecimalsAndZeroUnit() public {
        BadDecimalsToken bad = new BadDecimalsToken();
        address[] memory tokens = new address[](2);
        tokens[0] = address(wif);
        tokens[1] = address(bad);
        uint256[] memory units = new uint256[](2);
        units[0] = WIF_UNIT;
        units[1] = 1 ether;
        uint256[] memory caps = new uint256[](2);
        caps[0] = WIF_CAP;
        caps[1] = 100 ether;
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.InvalidToken.selector, address(bad)));
        new RixorLocker(address(wif), address(ownerSafe), address(guardianSafe), tokens, units, caps);

        vm.expectRevert(RixorLocker.InvalidAmount.selector);
        _deploy(address(ownerSafe), address(guardianSafe), address(wif), 0, WIF_CAP);
    }

    function test_constructor_rejectsDuplicateToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(wif);
        tokens[1] = address(wif);
        uint256[] memory units = new uint256[](2);
        units[0] = WIF_UNIT;
        units[1] = WIF_UNIT;
        uint256[] memory caps = new uint256[](2);
        caps[0] = WIF_CAP;
        caps[1] = WIF_CAP;
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.AlreadyListed.selector, address(wif)));
        new RixorLocker(address(wif), address(ownerSafe), address(guardianSafe), tokens, units, caps);
    }

    function test_constructor_state() public view {
        assertEq(locker.owner(), address(ownerSafe));
        assertEq(locker.guardian(), address(guardianSafe));
        assertEq(locker.WIF(), address(wif));
        assertTrue(locker.isListed(address(wif)) && locker.isListed(address(dope)));
        assertEq(locker.unitAmount(address(dope)), DOPE_UNIT);
        assertEq(locker.listedTokens().length, 2);
        assertEq(locker.tokenMultiplierBps(address(wif)), 20_000);
        assertEq(locker.tokenMultiplierBps(address(dope)), 10_000);
        assertEq(locker.tierMultiplierBps(0), 5_000);
        assertEq(locker.tierMultiplierBps(1), 15_000);
        assertEq(locker.tierMultiplierBps(2), 25_000);
    }

    function test_ownership_twoStepContractOnly() public {
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.NotContract.selector, alice));
        asOwner(abi.encodeCall(RixorLocker.transferOwnership, (alice)));

        MockSafe next = new MockSafe(bob);
        asOwner(abi.encodeCall(RixorLocker.transferOwnership, (address(next))));
        assertEq(locker.owner(), address(ownerSafe));
        vm.expectRevert(RixorLocker.NotPendingOwner.selector);
        vm.prank(alice);
        locker.acceptOwnership();
        vm.prank(bob);
        next.exec(address(locker), abi.encodeCall(RixorLocker.acceptOwnership, ()));
        assertEq(locker.owner(), address(next));
    }

    function test_adminFunctions_rejectNonOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.transferOwnership(address(ownerSafe));
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.setGuardian(address(ownerSafe));
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.unpause();
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.proposeListing(address(meme3), 1 ether, 10 ether);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.proposeUnitAmount(address(dope), DOPE_UNIT);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.proposeCapIncrease(address(dope), DOPE_CAP + 1);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.lowerCap(address(dope), 1);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.disableLocks(address(dope));
        vm.expectRevert(RixorLocker.NotOwner.selector);
        locker.proposeEnableLocks(address(dope));
        vm.expectRevert(RixorLocker.NotGuardian.selector);
        locker.pause();
        vm.expectRevert(RixorLocker.NotGuardian.selector);
        locker.activateEmergency();
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ locking

    function test_lock_allTiersRecordPositions() public {
        uint256 flex = lockAs(alice, address(dope), 2_000 ether, 0, 0);
        uint256 committed = lockAs(alice, address(dope), 3_000 ether, 1, 30);
        uint256 diamond = lockAs(alice, address(wif), 70_000 ether, 2, 90);

        RixorLocker.PositionView memory f = locker.positionOf(flex);
        assertEq(f.owner, alice);
        assertEq(f.endsAt, f.startedAt);
        assertEq(f.closedAt, 0);
        assertEq(locker.positionOf(committed).endsAt, block.timestamp + 30 days);
        assertEq(locker.positionOf(diamond).endsAt, block.timestamp + 90 days);
        assertEq(locker.positionsOf(alice).length, 3);
        assertEq(locker.tokenConfig(address(dope)).totalLocked, 5_000 ether);
        assertEq(dope.balanceOf(address(locker)), 5_000 ether);
    }

    function test_lock_validation() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.NotListed.selector, address(meme3)));
        locker.lock(address(meme3), 1 ether, 0, 0);
        vm.expectRevert(RixorLocker.InvalidTier.selector);
        locker.lock(address(dope), DOPE_UNIT, 3, 30);
        vm.expectRevert(RixorLocker.InvalidTerm.selector);
        locker.lock(address(dope), DOPE_UNIT, 0, 30);
        vm.expectRevert(RixorLocker.InvalidTerm.selector);
        locker.lock(address(dope), DOPE_UNIT, 1, 29);
        vm.expectRevert(RixorLocker.InvalidTerm.selector);
        locker.lock(address(dope), DOPE_UNIT, 2, 91);
        vm.expectRevert(RixorLocker.InvalidAmount.selector);
        locker.lock(address(dope), DOPE_UNIT - 1, 0, 0);
        vm.expectRevert(RixorLocker.InvalidAmount.selector);
        locker.lock(address(dope), DOPE_UNIT * 50 + 1, 0, 0);
        vm.stopPrank();
        // Exactly the bounds are accepted.
        lockAs(alice, address(dope), DOPE_UNIT, 1, 30);
        lockAs(alice, address(dope), DOPE_UNIT * 50, 2, 90);
    }

    function test_lock_capEnforced() public {
        for (uint256 i = 0; i < 10; i++) {
            lockAs(alice, address(dope), DOPE_UNIT * 50, 0, 0);
        }
        assertEq(locker.tokenConfig(address(dope)).totalLocked, DOPE_CAP);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.CapExceeded.selector, address(dope)));
        lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
    }

    function test_lock_rejectsIncompatibleTokens() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        FalseReturnToken falsy = new FalseReturnToken();
        _listViaTimelock(address(fot), 1 ether, 1_000 ether);
        _listViaTimelock(address(falsy), 1 ether, 1_000 ether);
        fot.mint(alice, 100 ether);
        falsy.mint(alice, 100 ether);
        vm.startPrank(alice);
        fot.approve(address(locker), type(uint256).max);
        falsy.approve(address(locker), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.IncompatibleToken.selector, address(fot)));
        locker.lock(address(fot), 10 ether, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.TransferFailed.selector, address(falsy)));
        locker.lock(address(falsy), 10 ether, 0, 0);
        vm.stopPrank();
    }

    function test_lock_acceptsNoReturnToken() public {
        NoReturnToken nr = new NoReturnToken();
        _listViaTimelock(address(nr), 1 ether, 1_000 ether);
        nr.mint(alice, 100 ether);
        vm.startPrank(alice);
        nr.approve(address(locker), type(uint256).max);
        uint256 id = locker.lock(address(nr), 10 ether, 0, 0);
        locker.exit(id, 0);
        vm.stopPrank();
        assertEq(nr.balanceOf(alice), 100 ether);
    }

    function test_reentrancy_blockedDuringLock() public {
        ReentrantToken bad = new ReentrantToken();
        _listViaTimelock(address(bad), 1 ether, 1_000 ether);
        bad.mint(alice, 100 ether);
        vm.prank(alice);
        bad.approve(address(locker), type(uint256).max);
        uint256 existing = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        // The token tries to call exit() on the Locker during transferFrom; the guard must stop it.
        bad.arm(address(locker), abi.encodeCall(RixorLocker.exit, (existing, 0)));
        lockAs(alice, address(bad), 10 ether, 0, 0);
        assertTrue(bad.reentered());
        assertFalse(bad.lastCallSucceeded());
        assertEq(locker.positionOf(existing).closedAt, 0);
    }

    // ------------------------------------------------------------------ exits

    function test_exit_flexibleNoFee() public {
        uint256 id = lockAs(alice, address(dope), 5_000 ether, 0, 0);
        uint256 before = dope.balanceOf(alice);
        vm.prank(alice);
        locker.exit(id, 0);
        assertEq(dope.balanceOf(alice) - before, 5_000 ether);
        assertEq(locker.positionOf(id).closedAt, block.timestamp);
        assertEq(locker.tokenConfig(address(dope)).totalLocked, 0);
    }

    function test_exit_committedFeeDecaysAndBurns() public {
        uint256 id = lockAs(alice, address(dope), 10_000 ether, 1, 30);
        (bool allowed, uint256 fee) = locker.exitTerms(id);
        assertTrue(allowed);
        assertEq(fee, 1_000); // 10% at the start
        vm.warp(block.timestamp + 15 days);
        (, fee) = locker.exitTerms(id);
        assertEq(fee, 500);
        vm.warp(block.timestamp + 15 days - 1);
        (, fee) = locker.exitTerms(id);
        assertEq(fee, 1); // rounds up: never 0 before the end
        vm.warp(block.timestamp + 1);
        (, fee) = locker.exitTerms(id);
        assertEq(fee, 0); // exactly at endsAt

        vm.warp(block.timestamp - 15 days); // back to mid-term for the burn check
        uint256 deadBefore = dope.balanceOf(DEAD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.FeeTooHigh.selector, 500, 499));
        locker.exit(id, 499);
        vm.prank(alice);
        locker.exit(id, 500);
        assertEq(dope.balanceOf(DEAD) - deadBefore, 500 ether);
        assertEq(dope.balanceOf(address(locker)), 0);
    }

    function test_exit_diamondLockedUntilExactEnd() public {
        uint256 id = lockAs(alice, address(wif), 70_000 ether, 2, 30);
        uint64 endsAt = locker.positionOf(id).endsAt;
        vm.warp(endsAt - 1);
        vm.prank(alice);
        vm.expectRevert(RixorLocker.StillLocked.selector);
        locker.exit(id, 10_000);
        vm.warp(endsAt);
        vm.prank(alice);
        locker.exit(id, 0);
        assertEq(locker.positionOf(id).closedAt, endsAt);
    }

    function test_exit_onlyOwnerAndOnce() public {
        uint256 id = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        vm.prank(bob);
        vm.expectRevert(RixorLocker.NotPositionOwner.selector);
        locker.exit(id, 0);
        vm.prank(alice);
        locker.exit(id, 0);
        uint64 closedAt = locker.positionOf(id).closedAt;
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(RixorLocker.PositionClosed.selector);
        locker.exit(id, 0);
        assertEq(locker.positionOf(id).closedAt, closedAt); // written once
    }

    function test_exit_feeRetainedWhenBurnAddressRejected() public {
        BlocksDeadToken nd = new BlocksDeadToken();
        _listViaTimelock(address(nd), 10 ether, 1_000 ether);
        nd.mint(alice, 100 ether);
        vm.prank(alice);
        nd.approve(address(locker), type(uint256).max);
        uint256 id = lockAs(alice, address(nd), 100 ether, 1, 30);
        vm.prank(alice);
        locker.exit(id, 1_000); // exit still works
        assertEq(nd.balanceOf(alice), 90 ether);
        assertEq(locker.retainedFees(address(nd)), 10 ether);
        assertEq(nd.balanceOf(address(locker)), 10 ether); // stays locked forever; no withdrawal function exists
    }

    // ------------------------------------------------------------------ pause and emergency

    function test_pause_blocksLocksNotExits() public {
        uint256 id = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        vm.prank(alice);
        vm.expectRevert(RixorLocker.IsPaused.selector);
        locker.lock(address(dope), DOPE_UNIT, 0, 0);
        vm.prank(alice);
        locker.exit(id, 0); // exits never blocked
        vm.prank(guardianOperator);
        vm.expectRevert(RixorLocker.NotOwner.selector);
        guardianSafe.exec(address(locker), abi.encodeCall(RixorLocker.unpause, ()));
        asOwner(abi.encodeCall(RixorLocker.unpause, ()));
        lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
    }

    function test_emergency_freesDiamondWithoutFeeAndIsIrreversible() public {
        uint256 diamond = lockAs(alice, address(wif), 70_000 ether, 2, 90);
        uint256 committed = lockAs(bob, address(dope), 10_000 ether, 1, 90);
        asGuardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        assertEq(locker.emergencyActivatedAt(), block.timestamp);
        assertTrue(locker.paused());

        vm.prank(alice);
        locker.exit(diamond, 0);
        vm.prank(bob);
        locker.exit(committed, 0);
        assertEq(wif.balanceOf(address(locker)), 0);
        assertEq(dope.balanceOf(address(locker)), 0);

        vm.expectRevert(RixorLocker.EmergencyActive.selector);
        asOwner(abi.encodeCall(RixorLocker.unpause, ()));
        vm.expectRevert(RixorLocker.EmergencyActive.selector);
        asGuardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        vm.prank(alice);
        vm.expectRevert(RixorLocker.IsPaused.selector);
        locker.lock(address(dope), DOPE_UNIT, 0, 0);
    }

    function test_adminCannotMovePrincipal() public {
        lockAs(alice, address(dope), 20_000 ether, 2, 90);
        uint256 held = dope.balanceOf(address(locker));
        // Every owner and guardian action, including emergency, leaves principal in place.
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        asOwner(abi.encodeCall(RixorLocker.lowerCap, (address(dope), 1)));
        asOwner(abi.encodeCall(RixorLocker.disableLocks, (address(dope))));
        MockSafe newGuardian = new MockSafe(guardianOperator);
        asOwner(abi.encodeCall(RixorLocker.setGuardian, (address(newGuardian))));
        // The replaced guardian loses its powers immediately.
        vm.prank(guardianOperator);
        vm.expectRevert(RixorLocker.NotGuardian.selector);
        guardianSafe.exec(address(locker), abi.encodeCall(RixorLocker.activateEmergency, ()));
        vm.prank(guardianOperator);
        newGuardian.exec(address(locker), abi.encodeCall(RixorLocker.activateEmergency, ()));
        assertEq(dope.balanceOf(address(locker)), held);
        assertEq(locker.positionOf(1).owner, alice);
    }

    // ------------------------------------------------------------------ registry timelocks

    function test_listing_timelocked() public {
        asOwner(abi.encodeCall(RixorLocker.proposeListing, (address(meme3), 500 ether, 100_000 ether)));
        vm.expectRevert();
        locker.executeListing(address(meme3));
        vm.warp(block.timestamp + 48 hours);
        locker.executeListing(address(meme3)); // anyone may execute a matured change
        assertTrue(locker.isListed(address(meme3)));
        lockAs(alice, address(meme3), 500 ether, 0, 0);
    }

    function test_listing_cancel() public {
        asOwner(abi.encodeCall(RixorLocker.proposeListing, (address(meme3), 500 ether, 100_000 ether)));
        asOwner(abi.encodeCall(RixorLocker.cancelListing, (address(meme3))));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(RixorLocker.NothingPending.selector);
        locker.executeListing(address(meme3));
    }

    function test_unitAmount_boundedTimelockedAndRateLimited() public {
        vm.expectRevert(RixorLocker.OutOfBounds.selector);
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT / 2 - 1)));
        vm.expectRevert(RixorLocker.OutOfBounds.selector);
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT * 3 / 2 + 1)));

        // Listed at construction; the 7-day interval counts from then.
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT * 3 / 2)));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(); // TooSoon: less than 7 days since listing
        locker.executeUnitAmount(address(dope));
        vm.warp(block.timestamp + 5 days);
        locker.executeUnitAmount(address(dope));
        assertEq(locker.unitAmount(address(dope)), DOPE_UNIT * 3 / 2);

        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT)));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(); // TooSoon again: 7 days since the last change
        locker.executeUnitAmount(address(dope));
    }

    function test_caps_raiseTimelockedLowerImmediate() public {
        vm.expectRevert(RixorLocker.OutOfBounds.selector);
        asOwner(abi.encodeCall(RixorLocker.proposeCapIncrease, (address(dope), DOPE_CAP * 2 + 1)));
        asOwner(abi.encodeCall(RixorLocker.proposeCapIncrease, (address(dope), DOPE_CAP * 2)));
        vm.expectRevert();
        locker.executeCapIncrease(address(dope));
        vm.warp(block.timestamp + 48 hours);
        locker.executeCapIncrease(address(dope));
        assertEq(locker.tokenConfig(address(dope)).maxTotalLocked, DOPE_CAP * 2);

        asOwner(abi.encodeCall(RixorLocker.lowerCap, (address(dope), 1_000 ether)));
        assertEq(locker.tokenConfig(address(dope)).maxTotalLocked, 1_000 ether);
    }

    function test_locks_disableImmediateEnableTimelocked() public {
        uint256 id = lockAs(alice, address(dope), DOPE_UNIT, 1, 30);
        asOwner(abi.encodeCall(RixorLocker.disableLocks, (address(dope))));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.LocksNotEnabled.selector, address(dope)));
        locker.lock(address(dope), DOPE_UNIT, 0, 0);
        vm.prank(alice);
        locker.exit(id, 1_000); // existing positions can always exit

        asOwner(abi.encodeCall(RixorLocker.proposeEnableLocks, (address(dope))));
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        locker.executeEnableLocks(address(dope));
        vm.warp(block.timestamp + 1);
        locker.executeEnableLocks(address(dope));
        lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_committedFeeMonotonicAndBounded(uint256 termDays, uint256 elapsed) public {
        termDays = bound(termDays, 30, 90);
        uint256 id = lockAs(alice, address(dope), DOPE_UNIT, 1, termDays);
        uint256 duration = termDays * 1 days;
        elapsed = bound(elapsed, 0, duration + 10 days);
        (, uint256 first) = locker.exitTerms(id);
        vm.warp(block.timestamp + elapsed);
        (bool allowed, uint256 later) = locker.exitTerms(id);
        assertTrue(allowed);
        assertLe(later, first);
        assertLe(later, 1_000);
        if (elapsed >= duration) assertEq(later, 0);
        else assertGt(later, 0);
    }

    function testFuzz_exitConservesTokens(uint256 amount, uint8 tier, uint256 elapsed) public {
        amount = bound(amount, DOPE_UNIT, DOPE_UNIT * 50);
        tier = uint8(bound(tier, 0, 1));
        uint256 id = lockAs(alice, address(dope), amount, tier, tier == 0 ? 0 : 30);
        vm.warp(block.timestamp + bound(elapsed, 0, 40 days));
        uint256 userBefore = dope.balanceOf(alice);
        uint256 deadBefore = dope.balanceOf(DEAD);
        vm.prank(alice);
        locker.exit(id, 10_000);
        assertEq((dope.balanceOf(alice) - userBefore) + (dope.balanceOf(DEAD) - deadBefore), amount);
        assertEq(dope.balanceOf(address(locker)), 0);
    }

    function testFuzz_unitBounds(uint256 proposed) public {
        proposed = bound(proposed, 1, DOPE_UNIT * 3);
        bool inBounds = proposed * 10_000 >= DOPE_UNIT * 5_000 && proposed * 10_000 <= DOPE_UNIT * 15_000;
        if (!inBounds) vm.expectRevert(RixorLocker.OutOfBounds.selector);
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), proposed)));
    }

    // ------------------------------------------------------------------ helpers

    function _listViaTimelock(address token, uint256 unit, uint256 cap) internal {
        asOwner(abi.encodeCall(RixorLocker.proposeListing, (token, unit, cap)));
        vm.warp(block.timestamp + 48 hours);
        locker.executeListing(token);
    }
}
