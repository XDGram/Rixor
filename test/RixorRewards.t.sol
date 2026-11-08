// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {IRixorLocker} from "../contracts/interfaces/IRixorLocker.sol";
import {MockERC20, MockSafe, FeeOnTransferToken} from "./utils/Mocks.sol";

/// @dev Reward-token stand-in that can be switched to revert on every transfer (an unavailable reward token).
contract BreakableToken is MockERC20 {
    bool public broken;

    constructor() MockERC20("Test Reward Token (WIF stand-in)", "tWIF", 18) {}

    function setBroken(bool b) external {
        broken = b;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!broken, "broken");
        super._transfer(from, to, amount);
    }
}

contract RixorRewardsTest is Test {
    uint256 internal constant DAY = 1 days;
    uint256 internal constant T0 = 20_800 * DAY; // a UTC midnight

    RixorLocker internal locker;
    RixorRewards internal rewards;
    MockERC20 internal meme; // Class A test meme token
    MockERC20 internal memeB; // Class B test meme token
    BreakableToken internal wif;
    MockSafe internal ownerSafe;
    MockSafe internal guardianSafe;
    address internal admin = makeAddr("admin-operator");
    address internal guardianOperator = makeAddr("guardian-operator");
    address internal funder = makeAddr("funder");
    address[5] internal who;

    function setUp() public {
        vm.warp(T0 - 2 hours);
        meme = new MockERC20("Test Meme A", "tMEMEA", 18);
        memeB = new MockERC20("Test Meme B", "tMEMEB", 18);
        wif = new BreakableToken();
        ownerSafe = new MockSafe(admin);
        guardianSafe = new MockSafe(guardianOperator);
        RixorLocker.Listing[] memory l = new RixorLocker.Listing[](2);
        l[0] = RixorLocker.Listing(address(meme), 1_000 ether, 10_000_000 ether, 1);
        l[1] = RixorLocker.Listing(address(memeB), 1_000 ether, 10_000_000 ether, 2);
        locker = new RixorLocker(address(ownerSafe), address(guardianSafe), l);
        rewards = new RixorRewards(IRixorLocker(address(locker)), address(wif));
        who = [makeAddr("ana"), makeAddr("ben"), makeAddr("cara"), makeAddr("dev"), makeAddr("eve")];
        for (uint256 i; i < 5; i++) {
            meme.mint(who[i], 1_000_000 ether);
            memeB.mint(who[i], 1_000_000 ether);
            vm.startPrank(who[i]);
            meme.approve(address(locker), type(uint256).max);
            memeB.approve(address(locker), type(uint256).max);
            vm.stopPrank();
        }
        wif.mint(funder, 100_000_000 ether);
        vm.prank(funder);
        wif.approve(address(rewards), type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers

    function _lock(uint256 i, uint256 amount, uint8 tier) internal returns (uint256) {
        return _lockToken(i, address(meme), amount, tier);
    }

    function _lockToken(uint256 i, address token, uint256 amount, uint8 tier) internal returns (uint256) {
        vm.prank(who[i]);
        return locker.lock(token, amount, tier, tier == 0 ? 0 : 30);
    }

    function _exit(uint256 i, uint256 id) internal {
        vm.prank(who[i]);
        locker.exit(id, 10_000);
    }

    function _claim(uint256 i, uint256 id) internal returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(who[i]);
        return rewards.claim(ids, 1_000);
    }

    function _fund(uint256 amount, uint256 days_) internal returns (uint256) {
        return _fundToken(address(meme), amount, days_);
    }

    function _fundToken(address token, uint256 amount, uint256 days_) internal returns (uint256) {
        vm.prank(funder);
        return rewards.fund(token, amount, days_);
    }

    function _guardian(bytes memory data) internal {
        vm.prank(guardianOperator);
        guardianSafe.exec(address(locker), data);
    }

    // ------------------------------------------------------------------ S0: matches the reference model to the wei

    /// @dev Expected values come from the exact BigInt reference model (ACC = 1e36), same scenario as the
    ///      V2 economic review: 100,000 WIF over 14 days, five holders, one exit at day 10 and one at day 12.
    function test_S0_matchesReferenceModelExactly() public {
        vm.warp(T0 - 1 hours);
        uint256 s = _fund(100_000 ether, 14); // starts at T0
        vm.warp(T0 + 12 hours);
        uint256 ana = _lock(0, 15_000 ether, 2);
        uint256 ben = _lock(1, 15_000 ether, 1);
        vm.warp(T0 + 1 days);
        uint256 cara = _lock(2, 6_000 ether, 0);
        vm.warp(T0 + 2 days);
        uint256 dev = _lock(3, 50_000 ether, 2);
        uint256 dev2 = _lock(3, 25_000 ether, 2); // 75,000 split across two positions (50-unit max per position)
        vm.warp(T0 + 7 days);
        uint256 eve = _lock(4, 15_000 ether, 2);
        vm.warp(T0 + 10 days);
        _exit(1, ben);
        vm.warp(T0 + 12 days);
        _exit(2, cara);
        vm.warp(T0 + 14 days);
        assertEq(_claim(0, ana), 18679044647646940423269, "ana");
        assertEq(_claim(1, ben), 8772283239643162552665, "ben");
        assertEq(_claim(2, cara), 1152486837117877686801, "cara");
        // Dev's two positions earn what one 75,000 position earns, give or take one wei of rounding each.
        assertApproxEqAbs(_claim(3, dev) + _claim(3, dev2), 60976005551159872559919, 2, "dev");
        assertEq(_claim(4, eve), 6848751153003574231744, "eve");
        assertEq(rewards.refund(s, 100), 3571428571428572545600, "unallocated + remainder refund");
        uint256 left = wif.balanceOf(address(rewards));
        assertLe(left, 4, "only a few wei of rounding dust remain");
        assertEq(rewards.totalClaimed() + rewards.totalRefunded() + left, 100_000 ether, "conservation");
    }

    // ------------------------------------------------------------------ exit independence

    function test_exit_worksWithoutAnyRewardsContract() public {
        RixorLocker.Listing[] memory l = new RixorLocker.Listing[](1);
        l[0] = RixorLocker.Listing(address(meme), 1_000 ether, 1_000_000 ether, 1);
        RixorLocker standalone = new RixorLocker(address(ownerSafe), address(guardianSafe), l);
        vm.startPrank(who[0]);
        meme.approve(address(standalone), type(uint256).max);
        uint256 id = standalone.lock(address(meme), 1_000 ether, 0, 0);
        uint256 before = meme.balanceOf(who[0]);
        standalone.exit(id, 0);
        vm.stopPrank();
        assertEq(meme.balanceOf(who[0]) - before, 1_000 ether);
    }

    function test_exit_worksWhenRewardTokenIsBroken() public {
        _fund(10_000 ether, 7);
        uint256 id = _lock(0, 1_000 ether, 0);
        vm.warp(block.timestamp + 3 days);
        wif.setBroken(true); // the reward token now reverts on every transfer
        uint256 before = meme.balanceOf(who[0]);
        _exit(0, id);
        assertEq(meme.balanceOf(who[0]) - before, 1_000 ether, "principal returned");
        vm.warp(block.timestamp + 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(who[0]);
        vm.expectRevert(RixorRewards.TransferFailed.selector);
        rewards.claim(ids, 1_000);
        // Accrual comes from immutable checkpoints and is recovered once the token works again.
        wif.setBroken(false);
        assertGt(_claim(0, id), 0);
    }

    function test_exitGas_independentOfStreamCount() public {
        uint256 a = _lock(0, 1_000 ether, 0);
        uint256 b = _lock(1, 1_000 ether, 0);
        vm.warp(block.timestamp + 1 days);
        uint256 g0 = gasleft();
        _exit(0, a);
        uint256 baseline = g0 - gasleft();
        for (uint256 i; i < 300; i++) {
            _fund(10_000 ether, 7 + (i % 84));
        }
        vm.warp(block.timestamp + 1 days);
        g0 = gasleft();
        _exit(1, b);
        uint256 withStreams = g0 - gasleft();
        emit log_named_uint("exit gas, 0 streams", baseline);
        emit log_named_uint("exit gas, 300 streams", withStreams);
        assertApproxEqAbs(withStreams, baseline, 25_000); // only warm/cold storage differences, no loops
    }

    // ------------------------------------------------------------------ emergency and release

    function test_emergency_freezesAccrualAndRefundsRemainder() public {
        vm.warp(T0 - 1 hours);
        uint256 s = _fund(70_000 ether, 7); // 10,000 WIF/day from T0
        vm.warp(T0);
        uint256 a = _lock(0, 1_000 ether, 2);
        vm.warp(T0 + 3 days);
        _guardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        vm.warp(T0 + 5 days);
        uint256 before = meme.balanceOf(who[0]);
        _exit(0, a); // Diamond exits with no fee, no Rewards involvement
        assertEq(meme.balanceOf(who[0]) - before, 1_000 ether);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(RixorRewards.TokenStopped.selector, address(meme)));
        rewards.fund(address(meme), 10_000 ether, 7);
        vm.warp(T0 + 30 days);
        uint256 got = _claim(0, a);
        uint256 back = rewards.refund(s, 100);
        assertApproxEqAbs(got, 30_000 ether, 1e6, "3 days accrued before the emergency");
        assertApproxEqAbs(back, 40_000 ether, 1e6, "4 unstreamed days refunded");
        assertLe(got + back, 70_000 ether);
    }

    function test_release_freezesThatTokenOnly() public {
        vm.warp(T0 - 1 hours);
        uint256 sA = _fundToken(address(meme), 70_000 ether, 7);
        uint256 sB = _fundToken(address(memeB), 70_000 ether, 7);
        vm.warp(T0);
        uint256 a = _lockToken(0, address(meme), 1_000 ether, 2);
        uint256 b = _lockToken(1, address(memeB), 1_000 ether, 1);
        vm.warp(T0 + 2 days);
        _guardian(abi.encodeCall(RixorLocker.releaseToken, (address(memeB))));
        assertEq(rewards.stopTime(address(memeB)), T0 + 2 days);
        assertEq(rewards.stopTime(address(meme)), 0);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(RixorRewards.TokenStopped.selector, address(memeB)));
        rewards.fund(address(memeB), 10_000 ether, 7);
        _exit(1, b); // Committed exits with no fee after release
        vm.warp(T0 + 10 days);
        assertApproxEqAbs(_claim(1, b), 20_000 ether, 1e6, "memeB: 2 days then frozen");
        assertApproxEqAbs(rewards.refund(sB, 100), 50_000 ether, 1e6, "memeB: 5 unstreamed days refunded");
        assertApproxEqAbs(_claim(0, a), 70_000 ether, 1e6, "meme: full stream");
        assertApproxEqAbs(rewards.refund(sA, 100), 0, 1e6);
    }

    function test_emergencyBeforeStreamStartRefundsEverything() public {
        vm.warp(T0 - 1 hours);
        uint256 s = _fund(70_000 ether, 7);
        _lock(0, 1_000 ether, 0);
        vm.warp(T0 - 30 minutes);
        _guardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        vm.warp(T0 + 1 days);
        assertEq(rewards.refund(s, 100), 70_000 ether);
    }

    // ------------------------------------------------------------------ batched sync

    function test_accrual_recoverableAfterLongUnsyncedGap() public {
        vm.warp(T0 - 1 hours);
        _fund(14_000 ether, 14);
        vm.warp(T0);
        uint256 a = _lock(0, 1_000 ether, 1);
        vm.warp(T0 + 10 days);
        _exit(0, a);
        vm.warp(T0 + 400 days); // nobody synced for over a year
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        vm.prank(who[0]);
        vm.expectRevert(abi.encodeWithSelector(RixorRewards.NeedsSync.selector, address(meme)));
        rewards.claim(ids, 5); // too few steps to catch up: reverts cleanly, nothing is lost
        while (!rewards.sync(address(meme), 50)) {}
        assertApproxEqAbs(_claim(0, a), 10_000 ether, 1e6);
    }

    function test_checkpointInCurrentBlockIsNotFinal() public {
        _fund(10_000 ether, 7);
        vm.warp(T0 + 1 days);
        uint256 id = _lock(0, 1_000 ether, 0);
        // Same block as the lock: its checkpoint can still change, so earnings are not knowable yet.
        (, bool ready) = rewards.earned(id);
        assertFalse(ready);
        assertEq(rewards.claimable(id), 0);
        vm.warp(block.timestamp + 1 days);
        rewards.sync(address(meme), 100);
        (uint256 total, bool ready2) = rewards.earned(id);
        assertTrue(ready2);
        assertApproxEqAbs(total, uint256(10_000 ether) / 7, 1e6);
    }

    // ------------------------------------------------------------------ validation

    function test_fund_validation() public {
        vm.startPrank(funder);
        vm.expectRevert(abi.encodeWithSelector(RixorRewards.NotListed.selector, address(wif)));
        rewards.fund(address(wif), 10_000 ether, 7);
        vm.expectRevert(RixorRewards.InvalidAmount.selector);
        rewards.fund(address(meme), 10_000 ether - 1, 7);
        vm.expectRevert(RixorRewards.InvalidDuration.selector);
        rewards.fund(address(meme), 10_000 ether, 6);
        vm.expectRevert(RixorRewards.InvalidDuration.selector);
        rewards.fund(address(meme), 10_000 ether, 91);
        uint256 id = rewards.fund(address(meme), 10_000 ether, 90);
        vm.stopPrank();
        RixorRewards.Stream memory s = rewards.streamOf(id);
        assertEq(s.funder, funder);
        assertEq(s.startDay * DAY, T0); // next UTC midnight
        assertEq(s.endDay - s.startDay, 90);
        assertEq(s.rate, uint256(10_000 ether) / (90 days));
        assertEq(rewards.totalFunded(), 10_000 ether);
        assertEq(wif.balanceOf(address(rewards)), 10_000 ether);
    }

    function test_constructor_validation() public {
        vm.expectRevert(RixorRewards.InvalidParams.selector);
        new RixorRewards(IRixorLocker(address(locker)), funder); // reward token must be a contract
        vm.expectRevert(RixorRewards.InvalidParams.selector);
        new RixorRewards(IRixorLocker(funder), address(wif));
        vm.expectRevert(RixorRewards.InvalidParams.selector);
        new RixorRewards(IRixorLocker(address(locker)), address(meme)); // a listed token cannot be the reward
    }

    function test_fund_rejectsFeeOnTransferRewardToken() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        RixorRewards r2 = new RixorRewards(IRixorLocker(address(locker)), address(fee));
        fee.mint(funder, 100_000 ether);
        vm.startPrank(funder);
        fee.approve(address(r2), type(uint256).max);
        vm.expectRevert(RixorRewards.IncompatibleToken.selector);
        r2.fund(address(meme), 10_000 ether, 7);
        vm.stopPrank();
    }

    function test_claim_onlyOwnerAndNoDoublePay() public {
        _fund(70_000 ether, 7);
        uint256 a = _lock(0, 1_000 ether, 0);
        vm.warp(T0 + 3 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = a;
        vm.prank(who[1]);
        vm.expectRevert(abi.encodeWithSelector(RixorRewards.NotPositionOwner.selector, a));
        rewards.claim(ids, 100);
        uint256 first = _claim(0, a);
        assertApproxEqAbs(first, 30_000 ether, 1e6);
        assertEq(_claim(0, a), 0, "nothing new in the same second");
        vm.warp(T0 + 4 days);
        assertApproxEqAbs(_claim(0, a), 10_000 ether, 1e6, "only the new day");
        assertEq(rewards.claimedOf(a), rewards.totalClaimed());
    }

    function test_claim_multipleTokensInOneCall() public {
        _fundToken(address(meme), 70_000 ether, 7);
        _fundToken(address(memeB), 14_000 ether, 7);
        uint256 a = _lockToken(0, address(meme), 1_000 ether, 0);
        uint256 b = _lockToken(0, address(memeB), 1_000 ether, 1);
        vm.warp(T0 + 7 days);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        vm.prank(who[0]);
        uint256 paid = rewards.claim(ids, 1_000);
        assertApproxEqAbs(paid, 84_000 ether, 1e6);
        assertEq(wif.balanceOf(who[0]), paid);
    }

    function test_refund_timingAndOnce() public {
        uint256 s = _fund(70_000 ether, 7);
        vm.warp(T0 + 3 days);
        vm.expectRevert(RixorRewards.NotReady.selector);
        rewards.refund(s, 100);
        vm.warp(T0 + 7 days);
        uint256 before = wif.balanceOf(funder);
        vm.prank(who[2]); // anyone may trigger it; the WIF goes to the funder
        uint256 back = rewards.refund(s, 100);
        assertEq(back, 70_000 ether, "no weight at all: everything returns");
        assertEq(wif.balanceOf(funder) - before, back);
        vm.expectRevert(RixorRewards.AlreadyRefunded.selector);
        rewards.refund(s, 100);
    }

    function test_zeroWeightGapIsRefundable() public {
        vm.warp(T0 - 1 hours);
        uint256 s = _fund(70_000 ether, 7);
        vm.warp(T0 + 2 days); // two days with nobody locked
        uint256 a = _lock(0, 1_000 ether, 0);
        vm.warp(T0 + 7 days);
        assertApproxEqAbs(_claim(0, a), 50_000 ether, 1e6);
        assertApproxEqAbs(rewards.refund(s, 100), 20_000 ether, 1e6);
    }

    function test_manyConcurrentStreamsNoCap() public {
        for (uint256 i; i < 50; i++) {
            _fund(10_000 ether, 7);
        }
        uint256 a = _lock(0, 1_000 ether, 0);
        vm.warp(T0 + 7 days);
        assertApproxEqAbs(_claim(0, a), 500_000 ether, 1e8);
    }

    // ------------------------------------------------------------------ randomized conservation

    function testFuzz_conservation(uint256 seed) public {
        uint256[] memory ids = new uint256[](6);
        uint256[] memory owners = new uint256[](6);
        uint256 nStreams = 1 + (seed % 4);
        uint256[] memory sids = new uint256[](nStreams * 2);
        vm.warp(T0 - 1 hours);
        for (uint256 i; i < nStreams; i++) {
            uint256 amt = 10_000 ether + (uint256(keccak256(abi.encode(seed, i, "a"))) % 500_000 ether);
            uint256 d = 7 + (uint256(keccak256(abi.encode(seed, i, "d"))) % 84);
            sids[2 * i] = _fundToken(address(meme), amt, d);
            sids[2 * i + 1] = _fundToken(address(memeB), amt / 2 + 10_000 ether, d);
            vm.warp(block.timestamp + (uint256(keccak256(abi.encode(seed, i, "t"))) % 3 days));
        }
        uint256 mode = seed % 5; // 0: emergency, 1: release memeB, else: neither
        for (uint256 i; i < 6; i++) {
            vm.warp(block.timestamp + (uint256(keccak256(abi.encode(seed, i, "w"))) % 5 days));
            owners[i] = i % 5;
            address token = i % 2 == 0 ? address(meme) : address(memeB);
            uint8 tier = uint8(i % 3);
            if (token == address(memeB) && tier == 2) tier = 1; // Class B: no Diamond
            ids[i] = _lockToken(owners[i], token, 1_000 ether + (uint256(keccak256(abi.encode(seed, i, "m"))) % 49_000 ether), tier);
        }
        if (mode == 0) {
            vm.warp(block.timestamp + 1 days);
            _guardian(abi.encodeCall(RixorLocker.activateEmergency, ()));
        } else if (mode == 1) {
            vm.warp(block.timestamp + 1 days);
            _guardian(abi.encodeCall(RixorLocker.releaseToken, (address(memeB))));
        }
        for (uint256 i; i < 6; i++) {
            if (uint256(keccak256(abi.encode(seed, i, "x"))) % 2 == 0) {
                vm.warp(block.timestamp + (uint256(keccak256(abi.encode(seed, i, "e"))) % 10 days));
                (bool allowed,) = locker.exitTerms(ids[i]);
                if (allowed) _exit(owners[i], ids[i]);
            }
        }
        vm.warp(block.timestamp + 200 days);
        while (!rewards.sync(address(meme), 200)) {}
        while (!rewards.sync(address(memeB), 200)) {}
        uint256 paid;
        for (uint256 i; i < 6; i++) {
            paid += _claim(owners[i], ids[i]);
        }
        uint256 refunded;
        for (uint256 i; i < sids.length; i++) {
            refunded += rewards.refund(sids[i], 10);
        }
        uint256 funded = rewards.totalFunded();
        assertLe(paid + refunded, funded, "never pays out more than funded");
        assertLt(funded - paid - refunded, 1e6, "only rounding dust remains");
        assertEq(wif.balanceOf(address(rewards)), funded - paid - refunded, "balance equals obligations");
    }
}
