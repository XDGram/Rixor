// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {RixorBase} from "./utils/RixorBase.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorChallenges} from "../contracts/RixorChallenges.sol";
import {IRixorLocker} from "../contracts/interfaces/IRixorLocker.sol";
import {MockERC20, MockSafe, FeeOnTransferToken, ReentrantToken} from "./utils/Mocks.sol";

contract RixorChallengesTest is RixorBase {
    uint256 internal constant POOL = 1_000_000 ether;

    // ------------------------------------------------------------------ helpers

    function seasonAsOwner(RixorChallenges.CreateParams memory p, uint256 pool) internal returns (uint256) {
        vm.prank(admin);
        bytes memory out = ownerSafe.exec(address(challenges), abi.encodeCall(RixorChallenges.createSeason, (p, pool)));
        return abi.decode(out, (uint256));
    }

    function emergency() internal {
        asGuardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
    }

    function exitAs(address who, uint256 positionId) internal {
        vm.prank(who);
        locker.exit(positionId, 10_000);
    }

    function claimAs(address who, uint256 id) internal returns (uint256) {
        vm.prank(who);
        return challenges.claim(id);
    }

    function refundAs(address who, uint256 id) internal returns (uint256) {
        vm.prank(who);
        return challenges.refund(id);
    }

    function sweepAs(address who, uint256 id) internal returns (uint256) {
        vm.prank(who);
        return challenges.sweep(id);
    }

    function _listMeme3() internal {
        asOwner(abi.encodeCall(RixorLocker.proposeListing, (address(meme3), 500 ether, 100_000 ether, 1)));
        vm.warp(block.timestamp + 48 hours);
        locker.executeListing(address(meme3));
    }

    function _assertAccounting(uint256 id) internal view {
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        assertEq(c.claimedTotal + c.refundedTotal + c.sweptTotal + c.escrow, c.pool, "per-challenge conservation");
        assertGe(wif.balanceOf(address(challenges)), challenges.totalEscrow(), "escrow coverage");
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_minHoldBounds() public {
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        new RixorChallenges(IRixorLocker(address(locker)), address(wif), 1 hours - 1);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        new RixorChallenges(IRixorLocker(address(locker)), address(wif), 7 days + 1);
        new RixorChallenges(IRixorLocker(address(locker)), address(wif), 1 hours);
        new RixorChallenges(IRixorLocker(address(locker)), address(wif), 7 days);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        new RixorChallenges(IRixorLocker(alice), address(wif), 24 hours);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        new RixorChallenges(IRixorLocker(address(locker)), alice, 24 hours); // prize token must be a contract
        assertEq(challenges.wif(), address(wif));
        assertEq(challenges.minHold(), MIN_HOLD);
    }

    // ------------------------------------------------------------------ creation

    function test_create_poolBounds() public {
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 2 days);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidAmount.selector);
        challenges.createChallenge(p, 100_000 ether - 1);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidAmount.selector);
        challenges.createChallenge(p, 10_000_000 ether + 1);
        uint256 a = createWith(sponsorA, p, 100_000 ether);
        uint256 b = createWith(sponsorA, p, 10_000_000 ether);
        assertEq(challenges.getChallenge(a).pool, 100_000 ether);
        assertEq(challenges.getChallenge(b).escrow, 10_000_000 ether);
        assertEq(challenges.totalEscrow(), 10_100_000 ether);
        assertEq(wif.balanceOf(address(challenges)), 10_100_000 ether);
        assertEq(challenges.contributionOf(a, sponsorA), 100_000 ether);
    }

    function test_create_communityTokenRules() public {
        // Any 1-3 distinct listed tokens. $WIF is not a lockable token and is never required.
        _listMeme3();
        address[] memory none = new address[](0);
        address[] memory dupe = new address[](2);
        dupe[0] = address(dope);
        dupe[1] = address(dope);
        address[] memory dupeOfThree = new address[](3);
        dupeOfThree[0] = address(dope);
        dupeOfThree[1] = address(pepe);
        dupeOfThree[2] = address(dope);
        address[] memory four = new address[](4);
        four[0] = address(dope);
        four[1] = address(pepe);
        four[2] = address(meme3);
        four[3] = makeAddr("fourth");

        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        challenges.createChallenge(params(none, 1 days, 2 days), POOL);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        challenges.createChallenge(params(four, 1 days, 2 days), POOL);
        vm.prank(sponsorA);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, address(dope)));
        challenges.createChallenge(params(dupe, 1 days, 2 days), POOL);
        vm.prank(sponsorA);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, address(dope)));
        challenges.createChallenge(params(dupeOfThree, 1 days, 2 days), POOL);
        // $WIF itself is not listed, so it cannot be a challenge token.
        vm.prank(sponsorA);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, address(wif)));
        challenges.createChallenge(params(only(address(wif)), 1 days, 2 days), POOL);
        // Unlisted token
        address unlisted = makeAddr("unlisted");
        vm.prank(sponsorA);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, unlisted));
        challenges.createChallenge(params(only(unlisted), 1 days, 2 days), POOL);

        // Valid shapes: one, two and three tokens, in any order.
        createWith(sponsorA, params(only(address(pepe)), 1 days, 2 days), POOL);
        createWith(sponsorA, params(dopePepe(), 1 days, 2 days), POOL);
        address[] memory three = new address[](3);
        three[0] = address(meme3);
        three[1] = address(pepe);
        three[2] = address(dope);
        uint256 id = createWith(sponsorA, params(three, 1 days, 2 days), POOL);
        address[] memory toks = challenges.challengeTokens(id);
        assertEq(toks.length, 3);
        assertEq(challenges.unitSnapshot(id, address(dope)), DOPE_UNIT);
        assertEq(challenges.unitSnapshot(id, address(pepe)), PEPE_UNIT);
        assertEq(challenges.unitSnapshot(id, address(meme3)), 500 ether);
        assertFalse(challenges.getChallenge(id).isSeason);

        // Listed but locks disabled
        asOwner(abi.encodeCall(RixorLocker.disableLocks, (address(dope))));
        vm.prank(sponsorA);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, address(dope)));
        challenges.createChallenge(params(only(address(dope)), 1 days, 2 days), POOL);
    }

    function test_createSeason_ownerOnlyAndManyTokens() public {
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 2 days);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.NotLockerOwner.selector);
        challenges.createSeason(p, POOL);
        // The guardian is not the owner either.
        vm.prank(guardianOperator);
        vm.expectRevert(RixorChallenges.NotLockerOwner.selector);
        guardianSafe.exec(address(challenges), abi.encodeCall(RixorChallenges.createSeason, (p, POOL)));

        uint256 before = wif.balanceOf(address(ownerSafe));
        uint256 id = seasonAsOwner(p, POOL);
        assertTrue(challenges.getChallenge(id).isSeason);
        assertEq(before - wif.balanceOf(address(ownerSafe)), POOL, "Season is funded by the Safe itself");

        address[] memory nine = new address[](9);
        for (uint256 i = 0; i < 9; i++) {
            nine[i] = address(dope);
        }
        RixorChallenges.CreateParams memory p9 = params(nine, 1 days, 2 days);
        vm.prank(admin);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        ownerSafe.exec(address(challenges), abi.encodeCall(RixorChallenges.createSeason, (p9, POOL)));
        // Duplicates rejected in Season lists too.
        address[] memory dupes = new address[](2);
        dupes[0] = address(dope);
        dupes[1] = address(dope);
        RixorChallenges.CreateParams memory pd = params(dupes, 1 days, 2 days);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.InvalidToken.selector, address(dope)));
        ownerSafe.exec(address(challenges), abi.encodeCall(RixorChallenges.createSeason, (pd, POOL)));
    }

    function test_create_timingBoundaries() public {
        uint64 nowTs = uint64(block.timestamp);
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 2 days);

        p.joinDeadline = nowTs; // must be strictly in the future
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidTiming.selector);
        challenges.createChallenge(p, POOL);

        p.joinDeadline = nowTs + 1 days;
        p.endTime = p.joinDeadline + uint64(MIN_HOLD) - 1; // hold window too short
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidTiming.selector);
        challenges.createChallenge(p, POOL);

        p.endTime = p.joinDeadline + uint64(MIN_HOLD); // exact minimum accepted
        createWith(sponsorA, p, POOL);

        p.endTime = nowTs + 30 days + 1; // too long
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.InvalidTiming.selector);
        challenges.createChallenge(p, POOL);

        p.endTime = nowTs + 30 days; // exact maximum accepted
        createWith(sponsorA, p, POOL);

        p.joinDeadline = nowTs + 1;
        p.endTime = nowTs + 1 + uint64(MIN_HOLD);
        createWith(sponsorA, p, POOL);
    }

    function test_create_paramValidation() public {
        RixorChallenges.CreateParams memory p;

        p = params(dopePepe(), 1 days, 2 days);
        p.minTier = 3;
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);

        p = params(dopePepe(), 1 days, 2 days);
        p.minUnitsPerEntry = 0;
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.minUnitsPerEntry = 11;
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.minUnitsPerEntry = 10;
        createWith(sponsorA, p, POOL);

        p = params(dopePepe(), 1 days, 2 days);
        p.maxParticipants = 0;
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.maxParticipants = 201;
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.maxParticipants = 200;
        createWith(sponsorA, p, POOL);

        p = params(dopePepe(), 1 days, 2 days);
        p.title = "";
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.title = string(new bytes(81));
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.title = string(new bytes(80));
        p.description = string(new bytes(2001));
        _expectCreateRevert(p, RixorChallenges.InvalidParams.selector);
        p.description = string(new bytes(2000));
        createWith(sponsorA, p, POOL);
    }

    function _expectCreateRevert(RixorChallenges.CreateParams memory p, bytes4 sel) internal {
        vm.prank(sponsorA);
        vm.expectRevert(sel);
        challenges.createChallenge(p, POOL);
    }

    function test_create_blockedWhenPausedOrEmergency() public {
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 2 days);
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        _expectCreateRevert(p, RixorChallenges.IsPaused.selector);
        asOwner(abi.encodeCall(RixorLocker.unpause, ()));
        createWith(sponsorA, p, POOL);
        emergency();
        _expectCreateRevert(p, RixorChallenges.EmergencyActive.selector);
    }

    function test_create_rejectsFeeOnTransferRewardToken() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        RixorChallenges c2 = new RixorChallenges(IRixorLocker(address(locker)), address(fee), MIN_HOLD);
        fee.mint(sponsorA, POOL);
        vm.startPrank(sponsorA);
        fee.approve(address(c2), type(uint256).max);
        vm.expectRevert(RixorChallenges.IncompatibleToken.selector);
        c2.createChallenge(params(only(address(dope)), 1 days, 2 days), POOL);
        vm.stopPrank();
    }

    function test_create_reentrancyBlocked() public {
        ReentrantToken rt = new ReentrantToken();
        RixorChallenges c2 = new RixorChallenges(IRixorLocker(address(locker)), address(rt), MIN_HOLD);
        rt.mint(sponsorA, 10 * POOL);
        vm.prank(sponsorA);
        rt.approve(address(c2), type(uint256).max);
        // Re-entry attempt: during the pool transfer, the token calls sponsor() on the same contract.
        rt.arm(address(c2), abi.encodeCall(RixorChallenges.sponsor, (1, 10_000 ether)));
        vm.prank(sponsorA);
        c2.createChallenge(params(only(address(dope)), 1 days, 2 days), POOL);
        assertTrue(rt.reentered());
        assertFalse(rt.lastCallSucceeded(), "reentrant call must fail");
        assertEq(c2.getChallenge(1).pool, POOL);
        assertEq(c2.totalEscrow(), POOL);
    }

    // ------------------------------------------------------------------ sponsorship

    function test_sponsor_boundsAndTiming() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.prank(sponsorB);
        vm.expectRevert(RixorChallenges.InvalidAmount.selector);
        challenges.sponsor(id, 10_000 ether - 1);
        vm.prank(sponsorB);
        vm.expectRevert(RixorChallenges.InvalidAmount.selector);
        challenges.sponsor(id, 10_000_000 ether - POOL + 1);
        vm.prank(sponsorB);
        challenges.sponsor(id, 10_000 ether);
        vm.prank(sponsorB);
        challenges.sponsor(id, 20_000 ether); // contributions accumulate
        assertEq(challenges.contributionOf(id, sponsorB), 30_000 ether);
        assertEq(challenges.getChallenge(id).pool, POOL + 30_000 ether);

        // Allowed after the join deadline, until endTime - 1.
        vm.warp(endTimeOf(id) - 1);
        vm.prank(sponsorA);
        challenges.sponsor(id, 10_000 ether);
        assertEq(challenges.contributionOf(id, sponsorA), POOL + 10_000 ether);
        vm.warp(endTimeOf(id));
        vm.prank(sponsorB);
        vm.expectRevert(RixorChallenges.ChallengeEnded.selector);
        challenges.sponsor(id, 10_000 ether);
        _assertAccounting(id);

        vm.expectRevert(RixorChallenges.ChallengeNotFound.selector);
        challenges.sponsor(999, 10_000 ether);
    }

    function test_sponsor_exactMaxPool() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.prank(sponsorB);
        challenges.sponsor(id, 10_000_000 ether - POOL);
        assertEq(challenges.getChallenge(id).pool, 10_000_000 ether);
        vm.prank(sponsorB);
        vm.expectRevert(RixorChallenges.InvalidAmount.selector);
        challenges.sponsor(id, 10_000 ether);
    }

    function test_sponsor_blockedWhilePaused() public {
        uint256 id = createDefault(sponsorA, POOL);
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        vm.prank(sponsorB);
        vm.expectRevert(RixorChallenges.IsPaused.selector);
        challenges.sponsor(id, 10_000 ether);
    }

    // ------------------------------------------------------------------ worked scoring example

    function test_scoring_workedExample() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 pa = lockAs(alice, address(pepe), 70_000 ether, 2, 90); // 10 tMEMEC units Diamond
        uint256 pb = lockAs(bob, address(dope), 10 * DOPE_UNIT, 2, 90); // 10 DOPE units Diamond
        uint256 pc = lockAs(carol, address(dope), 3 * DOPE_UNIT, 1, 30); // 3 DOPE units Committed
        uint256 pd = lockAs(dan, address(dope), 20 * DOPE_UNIT, 0, 0); // 20 units Flexible, capped at 10

        assertEq(challenges.previewPoints(id, pa), 250_000); // every token counts equally
        assertEq(challenges.previewPoints(id, pb), 250_000);
        assertEq(challenges.previewPoints(id, pc), 45_000);
        assertEq(challenges.previewPoints(id, pd), 50_000);

        joinAs(alice, id, pa);
        joinAs(bob, id, pb);
        joinAs(carol, id, pc);
        joinAs(dan, id, pd);
        assertEq(challenges.getChallenge(id).joinedPoints, 595_000);
        assertEq(challenges.entryOf(id, alice).points, 250_000);

        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        assertTrue(c.settled);
        assertTrue(c.success);
        assertEq(c.qualifiedPoints, 595_000);
        assertEq(c.qualifiedCount, 4);
        assertEq(c.claimDeadline, block.timestamp + 30 days);

        address[4] memory who = [alice, bob, carol, dan];
        uint256[4] memory pts = [uint256(250_000), 250_000, 45_000, 50_000];
        uint256 paid;
        for (uint256 i = 0; i < 4; i++) {
            uint256 expected = POOL * pts[i] / 595_000;
            assertEq(challenges.claimable(id, who[i]), expected);
            uint256 before = wif.balanceOf(who[i]);
            assertEq(claimAs(who[i], id), expected);
            assertEq(wif.balanceOf(who[i]) - before, expected);
            paid += expected;
        }
        // 420,168.067... / 420,168.067... / 75,630.252... / 84,033.613... WIF
        assertEq(POOL * 250_000 / 595_000, 420_168_067_226_890_756_302_521);
        uint256 dust = POOL - paid;
        assertLt(dust, 4, "rounding dust is below one wei per claimant");
        assertEq(challenges.getChallenge(id).escrow, dust);
        _assertAccounting(id);

        // Dust returns to the sponsor after the claim window.
        vm.warp(block.timestamp + 30 days + 1);
        assertEq(sweepAs(sponsorA, id), dust);
        assertEq(challenges.getChallenge(id).escrow, 0);
        assertEq(challenges.totalEscrow(), 0);
        _assertAccounting(id);
    }

    function test_scoring_maximumDepositCapsAtTenUnits() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 big = lockAs(alice, address(dope), 50 * DOPE_UNIT, 2, 90); // maximum position size
        uint256 small = lockAs(bob, address(dope), 10 * DOPE_UNIT, 2, 90);
        assertEq(challenges.previewPoints(id, big), challenges.previewPoints(id, small));
        uint256 pepeBig = lockAs(carol, address(pepe), 50 * PEPE_UNIT, 2, 90);
        assertEq(challenges.previewPoints(id, pepeBig), 250_000); // global maximum per entry
        uint256 minimum = lockAs(dan, address(dope), DOPE_UNIT, 0, 0);
        assertEq(challenges.previewPoints(id, minimum), 5_000); // global minimum per entry
    }

    function test_scoring_partialUnitsRoundDown() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 p = lockAs(alice, address(dope), 3 * DOPE_UNIT - 1, 1, 30); // 2.999 units -> 2
        assertEq(challenges.previewPoints(id, p), 2 * 15_000);
    }

    // ------------------------------------------------------------------ unit-size manipulation

    function test_unitChangeAfterCreationDoesNotAffectSnapshot() public {
        uint256 id1 = createWith(sponsorA, params(dopePepe(), 10 days, 12 days), POOL);
        uint256 p = lockAs(alice, address(dope), 10 * DOPE_UNIT, 2, 90);

        // Owner halves DOPE's unit (doubling every DOPE holder's units in new challenges).
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT / 2)));
        vm.warp(block.timestamp + 7 days);
        locker.executeUnitAmount(address(dope));
        assertEq(locker.unitAmount(address(dope)), DOPE_UNIT / 2);

        assertEq(challenges.unitSnapshot(id1, address(dope)), DOPE_UNIT, "existing challenge unaffected");
        uint256 p2 = lockAs(bob, address(dope), 5 * DOPE_UNIT, 2, 90);
        assertEq(challenges.previewPoints(id1, p2), 5 * 25_000);
        joinAs(alice, id1, p);
        assertEq(challenges.entryOf(id1, alice).points, 250_000);

        uint256 id2 = createWith(sponsorA, params(dopePepe(), 1 days, 2 days), POOL);
        assertEq(challenges.unitSnapshot(id2, address(dope)), DOPE_UNIT / 2);
        assertEq(challenges.previewPoints(id2, p2), 250_000, "new challenge uses the new unit");
    }

    function test_unitIncreaseCanDropSmallPositionsBelowMinimum() public {
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT, 0, 0); // exactly one old unit
        asOwner(abi.encodeCall(RixorLocker.proposeUnitAmount, (address(dope), DOPE_UNIT * 3 / 2)));
        vm.warp(block.timestamp + 7 days);
        locker.executeUnitAmount(address(dope));
        uint256 id = createDefault(sponsorA, POOL);
        assertEq(challenges.previewPoints(id, p), 0);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.BelowMinimumUnits.selector);
        challenges.join(id, p, address(0));
    }

    // ------------------------------------------------------------------ join validation

    function test_join_validation() public {
        RixorChallenges.CreateParams memory pr = params(only(address(dope)), 1 days, 2 days);
        pr.minTier = 1;
        pr.minUnitsPerEntry = 3;
        uint256 id = createWith(sponsorA, pr, POOL);

        uint256 otherToken = lockAs(alice, address(pepe), PEPE_UNIT * 5, 2, 90);
        uint256 flex = lockAs(alice, address(dope), 5 * DOPE_UNIT, 0, 0);
        uint256 twoUnits = lockAs(alice, address(dope), 2 * DOPE_UNIT, 1, 30);
        uint256 good = lockAs(alice, address(dope), 3 * DOPE_UNIT, 1, 30);
        uint256 closed = lockAs(alice, address(dope), 5 * DOPE_UNIT, 2, 90);

        vm.startPrank(bob);
        vm.expectRevert(RixorChallenges.NotPositionOwner.selector);
        challenges.join(id, good, address(0));
        vm.expectRevert(RixorChallenges.NotPositionOwner.selector);
        challenges.join(id, 999, address(0)); // nonexistent position
        vm.stopPrank();

        vm.startPrank(alice);
        vm.expectRevert(RixorChallenges.TokenNotAllowed.selector);
        challenges.join(id, otherToken, address(0));
        vm.expectRevert(RixorChallenges.TierTooLow.selector);
        challenges.join(id, flex, address(0));
        vm.expectRevert(RixorChallenges.BelowMinimumUnits.selector);
        challenges.join(id, twoUnits, address(0));
        vm.stopPrank();

        asGuardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        vm.prank(alice);
        locker.exit(closed, 0);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.EmergencyActive.selector);
        challenges.join(id, good, address(0));
    }

    function test_join_closedPositionRejected() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        exitAs(alice, p);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.PositionClosed.selector);
        challenges.join(id, p, address(0));
    }

    function test_join_positionMustCoverEndTime() public {
        uint256 early = lockAs(alice, address(dope), DOPE_UNIT, 1, 30); // ends now + 30 days
        uint256 earlyD = lockAs(bob, address(dope), DOPE_UNIT, 2, 30);
        vm.warp(block.timestamp + 1);
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 30 days); // ends 1s after the positions
        uint256 id = createWith(sponsorA, p, POOL);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.PositionEndsTooEarly.selector);
        challenges.join(id, early, address(0));
        vm.prank(bob);
        vm.expectRevert(RixorChallenges.PositionEndsTooEarly.selector);
        challenges.join(id, earlyD, address(0));

        // endsAt == endTime is accepted.
        uint256 exact = lockAs(carol, address(dope), DOPE_UNIT, 1, 30);
        uint256 id2 = createWith(sponsorA, params(dopePepe(), 1 days, 30 days), POOL);
        assertEq(locker.positionOf(exact).endsAt, endTimeOf(id2));
        joinAs(carol, id2, exact);
        // Flexible positions have no end and may join any challenge.
        uint256 flex = lockAs(dan, address(dope), DOPE_UNIT, 0, 0);
        joinAs(dan, id, flex);
    }

    function test_join_oncePerAddressAndMaxParticipants() public {
        RixorChallenges.CreateParams memory pr = params(dopePepe(), 1 days, 2 days);
        pr.maxParticipants = 2;
        uint256 id = createWith(sponsorA, pr, POOL);
        uint256 a1 = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        uint256 a2 = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        joinAs(alice, id, a1);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.AlreadyJoined.selector);
        challenges.join(id, a2, address(0));
        joinAs(bob, id, lockAs(bob, address(dope), DOPE_UNIT, 0, 0));
        uint256 c1 = lockAs(carol, address(dope), DOPE_UNIT, 0, 0);
        vm.prank(carol);
        vm.expectRevert(RixorChallenges.ChallengeFull.selector);
        challenges.join(id, c1, address(0));
        assertEq(challenges.getChallenge(id).participantCount, 2);
    }

    function test_join_exactDeadline() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint64 deadline = challenges.getChallenge(id).joinDeadline;
        uint256 a = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        uint256 b = lockAs(bob, address(dope), DOPE_UNIT, 0, 0);
        vm.warp(deadline);
        joinAs(alice, id, a); // inclusive
        vm.warp(deadline + 1);
        vm.prank(bob);
        vm.expectRevert(RixorChallenges.JoinClosed.selector);
        challenges.join(id, b, address(0));
    }

    function test_join_blockedWhilePaused() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 a = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.IsPaused.selector);
        challenges.join(id, a, address(0));
    }

    function test_join_nonexistentChallenge() public {
        uint256 a = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.ChallengeNotFound.selector);
        challenges.join(42, a, address(0));
    }

    // ------------------------------------------------------------------ lanes

    function test_lanes_communityDoubleOccupancyBlocked() public {
        uint256 c1 = createDefault(sponsorA, POOL);
        uint256 c2 = createDefault(sponsorB, POOL);
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT, 2, 90);
        joinAs(alice, c1, p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.LaneOccupied.selector, c1));
        challenges.join(c2, p, address(0));
        assertEq(challenges.communityLane(p), c1);
    }

    function test_lanes_seasonStacksWithOneCommunity() public {
        uint256 c1 = createDefault(sponsorA, POOL);
        uint256 s1 = seasonAsOwner(params(dopePepe(), 1 days, 2 days), POOL);
        uint256 s2 = seasonAsOwner(params(dopePepe(), 1 days, 2 days), POOL);
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT, 2, 90);
        joinAs(alice, c1, p);
        joinAs(alice, s1, p);
        assertEq(challenges.communityLane(p), c1);
        assertEq(challenges.seasonLane(p), s1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.LaneOccupied.selector, s1));
        challenges.join(s2, p, address(0));
    }

    function test_lanes_sequentialReuseAfterEnd() public {
        uint256 c1 = createDefault(sponsorA, POOL); // ends now + 2 days
        uint256 c2 = createWith(sponsorB, params(dopePepe(), 3 days, 4 days), POOL);
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT, 2, 90);
        joinAs(alice, c1, p);
        vm.warp(endTimeOf(c1) - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.LaneOccupied.selector, c1));
        challenges.join(c2, p, address(0));
        vm.warp(endTimeOf(c1)); // lane frees exactly at the end, before settlement
        joinAs(alice, c2, p);
        assertEq(challenges.communityLane(p), c2);
        // The earlier challenge still settles and pays the position.
        vm.warp(endTimeOf(c1) + 1);
        settleAll(c1);
        assertTrue(challenges.entryOf(c1, alice).qualified);
        assertEq(claimAs(alice, c1), POOL);
    }

    // ------------------------------------------------------------------ settlement and qualification

    function test_settle_onlyStrictlyAfterEnd() public {
        uint256 id = createDefault(sponsorA, POOL);
        joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id));
        vm.expectRevert(RixorChallenges.NotEnded.selector);
        challenges.settle(id, 10);
        vm.warp(endTimeOf(id) + 1);
        vm.expectRevert(RixorChallenges.InvalidParams.selector);
        challenges.settle(id, 0);
        settleAll(id);
        vm.expectRevert(RixorChallenges.AlreadySettled.selector);
        challenges.settle(id, 10);
    }

    function test_qualification_exitBoundaries() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 a = lockAs(alice, address(dope), DOPE_UNIT, 0, 0);
        uint256 b = lockAs(bob, address(dope), DOPE_UNIT, 0, 0);
        uint256 c = lockAs(carol, address(dope), DOPE_UNIT, 0, 0);
        uint256 d = lockAs(dan, address(dope), DOPE_UNIT, 0, 0);
        joinAs(alice, id, a);
        joinAs(bob, id, b);
        joinAs(carol, id, c);
        joinAs(dan, id, d);
        uint64 end = endTimeOf(id);
        vm.warp(end - 1);
        exitAs(alice, a); // one second early: disqualified
        vm.warp(end);
        exitAs(bob, b); // exactly at end: qualifies
        vm.warp(end + 5 days);
        exitAs(carol, c); // after end, before settlement: qualifies (closedAt is immutable)
        settleAll(id);
        assertFalse(challenges.entryOf(id, alice).qualified);
        assertTrue(challenges.entryOf(id, bob).qualified);
        assertTrue(challenges.entryOf(id, carol).qualified);
        assertTrue(challenges.entryOf(id, dan).qualified);
        assertEq(challenges.getChallenge(id).qualifiedPoints, 3 * 5_000);

        vm.prank(alice);
        vm.expectRevert(RixorChallenges.NotQualified.selector);
        challenges.claim(id);
        assertEq(claimAs(bob, id), POOL / 3);
        assertEq(claimAs(carol, id), POOL / 3);
        assertEq(claimAs(dan, id), POOL / 3);
        _assertAccounting(id);
    }

    function test_settle_batching() public {
        uint256 id = createDefault(sponsorA, POOL);
        address[5] memory who = [alice, bob, carol, dan, sponsorB];
        for (uint256 i = 0; i < who.length; i++) {
            joinAs(who[i], id, lockAs(who[i], address(dope), DOPE_UNIT * (i + 1), 0, 0));
        }
        vm.warp(endTimeOf(id) + 1);
        challenges.settle(id, 2);
        assertEq(challenges.getChallenge(id).settleCursor, 2);
        assertFalse(challenges.getChallenge(id).settled);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.NotSettled.selector);
        challenges.claim(id);
        challenges.settle(id, 2);
        challenges.settle(id, 2); // only one left; caps at the end
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        assertTrue(c.settled);
        assertEq(c.settleCursor, 5);
        assertEq(c.qualifiedCount, 5);
        assertEq(c.qualifiedPoints, 5_000 * (1 + 2 + 3 + 4 + 5));
    }

    function test_settle_twoHundredParticipantsInBatches() public {
        uint256 id = createDefault(sponsorA, POOL);
        for (uint256 i = 0; i < 200; i++) {
            address w = address(uint160(0x100000 + i));
            dope.mint(w, DOPE_UNIT);
            vm.startPrank(w);
            dope.approve(address(locker), DOPE_UNIT);
            uint256 pid = locker.lock(address(dope), DOPE_UNIT, 0, 0);
            challenges.join(id, pid, address(0));
            vm.stopPrank();
        }
        vm.prank(alice);
        uint256 extra = locker.lock(address(dope), DOPE_UNIT, 0, 0);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.ChallengeFull.selector);
        challenges.join(id, extra, address(0));
        vm.warp(endTimeOf(id) + 1);
        uint256 g = gasleft();
        challenges.settle(id, 200);
        assertLt(g - gasleft(), 15_000_000, "a full settle fits comfortably in a block");
        assertTrue(challenges.getChallenge(id).settled);
        assertEq(challenges.participants(id, 190, 50).length, 10);
        assertEq(challenges.participants(id, 500, 50).length, 0);
    }

    function test_goal_successAtExactGoalFailureBelow() public {
        RixorChallenges.CreateParams memory pr = params(dopePepe(), 1 days, 2 days);
        pr.goalPoints = 10_000;
        uint256 ok = createWith(sponsorA, pr, POOL);
        uint256 failing = createWith(sponsorA, pr, POOL);
        uint256 a = lockAs(alice, address(dope), 2 * DOPE_UNIT, 0, 0); // 10,000 points
        uint256 b = lockAs(bob, address(dope), 2 * DOPE_UNIT, 0, 0);
        joinAs(alice, ok, a);
        joinAs(bob, failing, b);
        vm.warp(endTimeOf(ok) - 1);
        exitAs(bob, b);
        vm.warp(endTimeOf(ok) + 1);
        settleAll(ok);
        settleAll(failing);
        assertTrue(challenges.getChallenge(ok).success);
        assertFalse(challenges.getChallenge(failing).success);

        vm.prank(bob);
        vm.expectRevert(RixorChallenges.NotSuccessful.selector);
        challenges.claim(failing);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.NotRefundable.selector);
        challenges.refund(ok);
        assertEq(refundAs(sponsorA, failing), POOL);
        assertEq(claimAs(alice, ok), POOL);
        _assertAccounting(ok);
        _assertAccounting(failing);
    }

    function test_noParticipants_failsAndRefunds() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        assertTrue(challenges.getChallenge(id).settled);
        assertFalse(challenges.getChallenge(id).success);
        assertEq(refundAs(sponsorA, id), POOL);
        assertEq(challenges.totalEscrow(), 0);
    }

    // ------------------------------------------------------------------ claims

    function test_claim_onceAndDeadline() public {
        uint256 id = createDefault(sponsorA, POOL);
        joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        joinAs(bob, id, lockAs(bob, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        uint64 deadline = challenges.getChallenge(id).claimDeadline;
        assertEq(claimAs(alice, id), POOL / 2);
        assertEq(challenges.claimable(id, alice), 0);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.AlreadyClaimed.selector);
        challenges.claim(id);
        vm.prank(carol);
        vm.expectRevert(RixorChallenges.NotQualified.selector);
        challenges.claim(id);

        vm.warp(deadline); // inclusive
        assertEq(claimAs(bob, id), POOL / 2);
        _assertAccounting(id);
    }

    function test_claim_afterDeadlineRejectedAndSwept() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.prank(sponsorB);
        challenges.sponsor(id, POOL / 2); // sponsorA 2/3, sponsorB 1/3
        uint256 pool = POOL + POOL / 2;
        joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        joinAs(bob, id, lockAs(bob, address(dope), 3 * DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        uint64 deadline = challenges.getChallenge(id).claimDeadline;
        uint256 aliceGot = claimAs(alice, id);
        assertEq(aliceGot, pool / 4);

        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.ClaimWindowOpen.selector);
        challenges.sweep(id);
        vm.warp(deadline + 1);
        vm.prank(bob);
        vm.expectRevert(RixorChallenges.ClaimWindowClosed.selector);
        challenges.claim(id);
        assertEq(challenges.claimable(id, bob), 0);

        uint256 remaining = pool - aliceGot;
        uint256 a = sweepAs(sponsorA, id);
        uint256 b = sweepAs(sponsorB, id);
        assertEq(a, remaining * POOL / pool);
        assertEq(b, remaining * (POOL / 2) / pool);
        assertLe(a + b, remaining);
        assertLt(remaining - (a + b), 2);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.AlreadySwept.selector);
        challenges.sweep(id);
        vm.prank(carol);
        vm.expectRevert(RixorChallenges.NothingToSweep.selector);
        challenges.sweep(id);
        _assertAccounting(id);
    }

    function test_sweep_rejectedOnFailedChallenge() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.warp(endTimeOf(id) + 31 days);
        settleAll(id);
        vm.warp(block.timestamp + 31 days);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.NotSettled.selector);
        challenges.sweep(id);
    }

    // ------------------------------------------------------------------ refunds

    function test_refund_coSponsorsExactAndOnce() public {
        uint256 id = createDefault(sponsorA, 300_000 ether);
        vm.prank(sponsorB);
        challenges.sponsor(id, 100_000 ether);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.NotRefundable.selector);
        challenges.refund(id); // not settled
        vm.warp(endTimeOf(id) + 1);
        settleAll(id); // nobody joined -> failed
        uint256 ba = wif.balanceOf(sponsorA);
        assertEq(refundAs(sponsorA, id), 300_000 ether);
        assertEq(wif.balanceOf(sponsorA) - ba, 300_000 ether);
        assertEq(refundAs(sponsorB, id), 100_000 ether);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.AlreadyRefunded.selector);
        challenges.refund(id);
        vm.prank(carol);
        vm.expectRevert(RixorChallenges.NothingToRefund.selector);
        challenges.refund(id);
        _assertAccounting(id);
        assertEq(challenges.getChallenge(id).escrow, 0);
    }

    // ------------------------------------------------------------------ emergency

    function test_emergency_cancelsRunningChallengeAndRefunds() public {
        uint256 id = createDefault(sponsorA, POOL);
        vm.prank(sponsorB);
        challenges.sponsor(id, 50_000 ether);
        uint256 p = lockAs(alice, address(dope), DOPE_UNIT * 10, 2, 90);
        joinAs(alice, id, p);
        vm.warp(endTimeOf(id) - 1);
        emergency();
        assertTrue(challenges.isCancelled(id));

        _expectLockBlocked();
        vm.warp(endTimeOf(id) + 1);
        vm.expectRevert(RixorChallenges.Cancelled.selector);
        challenges.settle(id, 10);
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.NotSettled.selector);
        challenges.claim(id);
        // Refunds and exits remain available, Diamond exits are fee-free.
        assertEq(refundAs(sponsorA, id), POOL);
        assertEq(refundAs(sponsorB, id), 50_000 ether);
        uint256 before = dope.balanceOf(alice);
        vm.prank(alice);
        locker.exit(p, 0);
        assertEq(dope.balanceOf(alice) - before, DOPE_UNIT * 10);
        _assertAccounting(id);
        assertEq(challenges.totalEscrow(), 0);
    }

    function _expectLockBlocked() internal {
        vm.prank(bob);
        vm.expectRevert(RixorLocker.IsPaused.selector);
        locker.lock(address(dope), DOPE_UNIT, 0, 0);
    }

    function test_emergency_doesNotAffectSettledClaimsOrSweeps() public {
        uint256 id = createDefault(sponsorA, POOL);
        joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        joinAs(bob, id, lockAs(bob, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        emergency();
        assertFalse(challenges.isCancelled(id));
        assertEq(claimAs(alice, id), POOL / 2);
        vm.prank(sponsorA);
        vm.expectRevert(RixorChallenges.NotRefundable.selector);
        challenges.refund(id);
        vm.warp(block.timestamp + 31 days);
        assertEq(sweepAs(sponsorA, id), POOL / 2);
        _assertAccounting(id);
    }

    function test_emergency_afterEndBeforeSettleStillSettles() public {
        uint256 id = createDefault(sponsorA, POOL);
        uint256 a = lockAs(alice, address(dope), DOPE_UNIT, 2, 90);
        joinAs(alice, id, a);
        vm.warp(endTimeOf(id)); // emergency exactly at endTime: the challenge had completed its hold
        emergency();
        assertFalse(challenges.isCancelled(id));
        vm.prank(alice);
        locker.exit(a, 0); // closedAt == endTime -> still qualifies
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        assertTrue(challenges.getChallenge(id).success);
        assertEq(claimAs(alice, id), POOL);
    }

    function test_emergency_oneSecondBeforeEndCancels() public {
        uint256 id = createDefault(sponsorA, POOL);
        joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id) - 1);
        emergency();
        assertTrue(challenges.isCancelled(id));
        assertEq(refundAs(sponsorA, id), POOL);
    }

    function test_pause_doesNotBlockSettleClaimRefundSweep() public {
        uint256 ok = createDefault(sponsorA, POOL);
        uint256 failed = createDefault(sponsorB, POOL);
        joinAs(alice, ok, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(ok) + 1);
        asGuardian(abi.encodeCall(RixorLocker.pause, ()));
        settleAll(ok);
        settleAll(failed);
        assertEq(claimAs(alice, ok), POOL);
        assertEq(refundAs(sponsorB, failed), POOL);
    }

    // ------------------------------------------------------------------ escrow isolation

    function test_escrowIsolationBetweenChallenges() public {
        uint256 c1 = createDefault(sponsorA, POOL);
        uint256 c2 = createDefault(sponsorB, 200_000 ether);
        joinAs(alice, c1, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        joinAs(bob, c2, lockAs(bob, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(c1) + 1);
        settleAll(c1);
        settleAll(c2);
        assertEq(claimAs(alice, c1), POOL);
        // Alice is not in c2 and cannot touch it; c2 still holds exactly its own pool.
        vm.prank(alice);
        vm.expectRevert(RixorChallenges.NotQualified.selector);
        challenges.claim(c2);
        assertEq(challenges.getChallenge(c2).escrow, 200_000 ether);
        assertEq(challenges.totalEscrow(), 200_000 ether);
        assertEq(wif.balanceOf(address(challenges)), 200_000 ether);
        assertEq(claimAs(bob, c2), 200_000 ether);
        assertEq(challenges.totalEscrow(), 0);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_payoutsNeverExceedPool(
        uint256 pool,
        uint256[4] memory amounts,
        uint8[4] memory tiers,
        uint8 exits
    ) public {
        pool = bound(pool, 100_000 ether, 10_000_000 ether);
        uint256 id = createWith(sponsorA, params(dopePepe(), 1 days, 2 days), pool);
        address[4] memory who = [alice, bob, carol, dan];
        uint256[4] memory pids;
        for (uint256 i = 0; i < 4; i++) {
            uint8 tier = tiers[i] % 3;
            address token = i % 2 == 0 ? address(dope) : address(pepe);
            uint256 unit = token == address(dope) ? DOPE_UNIT : PEPE_UNIT;
            uint256 amount = bound(amounts[i], unit, 50 * unit);
            pids[i] = lockAs(who[i], token, amount, tier, tier == 0 ? 0 : 90);
            joinAs(who[i], id, pids[i]);
        }
        vm.warp(endTimeOf(id) - 1);
        for (uint256 i = 0; i < 4; i++) {
            if ((exits >> i) & 1 == 1 && tiers[i] % 3 != 2) exitAs(who[i], pids[i]);
        }
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        uint256 paid;
        if (c.success) {
            for (uint256 i = 0; i < 4; i++) {
                if (challenges.entryOf(id, who[i]).qualified) paid += claimAs(who[i], id);
            }
            assertLe(paid, pool);
            assertLt(pool - paid, 4);
            vm.warp(block.timestamp + 31 days);
            paid += sweepAs(sponsorA, id);
            assertEq(paid, pool);
        } else {
            assertEq(refundAs(sponsorA, id), pool);
        }
        _assertAccounting(id);
        assertEq(challenges.totalEscrow(), 0);
    }

    function testFuzz_refundAndSweepNeverExceedContribution(uint256 a, uint256 b, bool succeed) public {
        a = bound(a, 100_000 ether, 5_000_000 ether);
        b = bound(b, 10_000 ether, 5_000_000 ether);
        uint256 id = createWith(sponsorA, params(dopePepe(), 1 days, 2 days), a);
        vm.prank(sponsorB);
        challenges.sponsor(id, b);
        if (succeed) joinAs(alice, id, lockAs(alice, address(dope), DOPE_UNIT, 0, 0));
        vm.warp(endTimeOf(id) + 1);
        settleAll(id);
        uint256 ra;
        uint256 rb;
        if (succeed) {
            vm.warp(block.timestamp + 31 days); // nobody claimed: everything sweeps back
            ra = sweepAs(sponsorA, id);
            rb = sweepAs(sponsorB, id);
        } else {
            ra = refundAs(sponsorA, id);
            rb = refundAs(sponsorB, id);
        }
        assertLe(ra, a);
        assertLe(rb, b);
        assertLe(ra + rb, a + b);
        assertLt(a + b - ra - rb, 2);
        _assertAccounting(id);
    }
}
