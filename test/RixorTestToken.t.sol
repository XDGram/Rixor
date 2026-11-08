// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RixorTestToken} from "../contracts/testtokens/RixorTestToken.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {IRixorLocker} from "../contracts/interfaces/IRixorLocker.sol";
import {MockSafe} from "./utils/Mocks.sol";

/// @dev TEST tokens for the testnet demo, and the testnet defaults (including a 6-decimal Class B token) running
///      through the real Locker and Rewards.
contract RixorTestTokenTest is Test {
    address internal alice = makeAddr("alice");
    address internal funder = makeAddr("funder");

    function test_refusesMainnet() public {
        vm.chainId(4663);
        vm.expectRevert(RixorTestToken.MainnetNotAllowed.selector);
        new RixorTestToken("Rixor Test Meme A (TEST)", "tMEMEA", 18, 1e27, address(this), 1e23);
    }

    function test_faucetCooldownAndExactTransfers() public {
        vm.warp(1_800_000_000);
        RixorTestToken t = new RixorTestToken("Rixor Test Meme B (TEST)", "tMEMEB", 6, 1_000_000_000e6, address(this), 100_000e6);
        assertEq(t.decimals(), 6);
        assertEq(t.totalSupply(), 1_000_000_000e6);
        vm.prank(alice);
        assertEq(t.faucet(), 100_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorTestToken.FaucetCooldown.selector, block.timestamp + 1 days));
        t.faucet();
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        t.faucet();
        assertEq(t.balanceOf(alice), 200_000e6);
        vm.prank(alice);
        t.transfer(funder, 1);
        assertEq(t.balanceOf(funder), 1);
    }

    function test_testnetDefaults_sixDecimalClassBThroughLockerAndRewards() public {
        uint256 day = 1 days;
        vm.warp(20_800 * day - 2 hours);
        RixorTestToken memeA = new RixorTestToken("Rixor Test Meme A (TEST)", "tMEMEA", 18, 1_000_000_000e18, address(this), 100_000e18);
        RixorTestToken memeB = new RixorTestToken("Rixor Test Meme B (TEST)", "tMEMEB", 6, 1_000_000_000e6, address(this), 100_000e6);
        RixorTestToken tWif = new RixorTestToken("Rixor Test Reward (TEST)", "tWIF", 18, 1_000_000_000e18, funder, 250_000e18);
        RixorLocker.Listing[] memory l = new RixorLocker.Listing[](2);
        l[0] = RixorLocker.Listing(address(memeA), 1_000e18, 20_000_000e18, 1);
        l[1] = RixorLocker.Listing(address(memeB), 1_000e6, 10_000_000e6, 2);
        RixorLocker locker = new RixorLocker(address(new MockSafe(address(1))), address(new MockSafe(address(2))), l);
        RixorRewards rewards = new RixorRewards(IRixorLocker(address(locker)), address(tWif));

        vm.startPrank(funder);
        tWif.approve(address(rewards), type(uint256).max);
        rewards.fund(address(memeB), 70_000e18, 7); // 10,000 tWIF per day to tMEMEB lockers
        vm.stopPrank();

        vm.startPrank(alice);
        memeB.faucet();
        memeB.approve(address(locker), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.TierNotAllowed.selector, 2));
        locker.lock(address(memeB), 50_000e6, 2, 30); // Class B: no Diamond
        uint256 id = locker.lock(address(memeB), 50_000e6, 1, 60); // 50 units, Committed, 60 days (Class B maximum)
        vm.stopPrank();
        assertEq(locker.positionOf(id).weight, 75_000e6);

        vm.warp(20_800 * day + 3 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(alice);
        uint256 got = rewards.claim(ids, 500);
        // A 6-decimal weight still earns the full stream with negligible rounding (accumulator precision 1e36).
        assertApproxEqAbs(got, 30_000e18, 1e6);

        vm.prank(alice);
        locker.exit(id, 10_000); // early exit: fee burned, principal otherwise returned exactly
        assertEq(memeB.balanceOf(address(locker)), 0);
    }
}
