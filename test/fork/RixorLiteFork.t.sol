// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {RixorLite, IERC20Lite} from "../../contracts/RixorLite.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice RixorLite against the REAL HOOKR and $WIF token code on a local fork of Robinhood Chain mainnet, with the
///         exact parameters of the planned deployment. Nothing is sent to any network.
///
///         Run with: npm run test:fork   (RH_MAINNET_RPC_URL overrides the public RPC)
contract RixorLiteForkTest is Test {
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    uint256 internal constant BUDGET = 1_000 ether;
    uint256 internal constant DURATION = 7 days;
    uint256 internal constant LOCK = 1 days;
    uint256 internal constant MIN = 10 ether;
    uint256 internal constant CAP = 100_000 ether;

    RixorLite internal lite;
    address internal rewardWallet = makeAddr("lite-reward-wallet");
    address internal alice = makeAddr("lite-alice");
    address internal bob = makeAddr("lite-bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_MAINNET_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        assertEq(block.chainid, 4663, "not Robinhood Chain mainnet");
        console2.log("fork block", block.number);
        assertEq(IERC20Approve(WIF).decimals(), 18);
        assertEq(IERC20Approve(HOOKR).decimals(), 18);
        lite = new RixorLite(HOOKR, WIF, rewardWallet, BUDGET, DURATION, LOCK, MIN, CAP);
        deal(WIF, rewardWallet, BUDGET);
        vm.prank(rewardWallet);
        IERC20Approve(WIF).approve(address(lite), BUDGET);
        deal(HOOKR, alice, 1_000 ether);
        deal(HOOKR, bob, 1_000 ether);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20Lite(token).balanceOf(who);
    }

    function test_fork_lite_fullFlowWithRealTokens() public {
        // connect -> approve the exact amount -> lock
        vm.startPrank(alice);
        IERC20Approve(HOOKR).approve(address(lite), 50 ether);
        lite.lock(50 ether);
        vm.stopPrank();
        assertEq(_bal(HOOKR, address(lite)), 50 ether, "real HOOKR arrives exactly");
        assertEq(IERC20Lite(HOOKR).allowance(alice, address(lite)), 0, "exact approval fully used");

        // earn
        skip(10 minutes);
        uint256 due = lite.earned(alice);
        assertApproxEqAbs(due, lite.rate() * 10 minutes, 1);
        console2.log("WIF wei earned by a sole locker in 10 minutes", due);

        // claim: real WIF moves from the reward wallet to the user
        vm.prank(alice);
        lite.claim();
        assertEq(_bal(WIF, alice), due, "real WIF received");
        assertEq(_bal(WIF, rewardWallet), BUDGET - due, "paid by the reward wallet");
        assertEq(_bal(WIF, address(lite)), 0, "the contract holds no WIF");
        assertEq(lite.rewardsAvailable(), BUDGET - due);

        // a second locker shares the rate
        vm.startPrank(bob);
        IERC20Approve(HOOKR).approve(address(lite), 150 ether);
        lite.lock(150 ether);
        vm.stopPrank();
        skip(1 hours);
        assertApproxEqAbs(lite.earned(alice), (lite.rate() * 1 hours) / 4, 2);
        assertApproxEqAbs(lite.earned(bob), (lite.rate() * 1 hours * 3) / 4, 2);

        // exit is blocked during the lock period and exact after it
        vm.prank(alice);
        vm.expectRevert();
        lite.exit();
        skip(LOCK);
        vm.prank(alice);
        lite.exit();
        assertEq(_bal(HOOKR, alice), 1_000 ether, "exact principal back");
        assertEq(_bal(HOOKR, address(lite)), 150 ether, "bob's tokens untouched");
    }

    function test_fork_lite_rewardWalletCanStopRewardsButNeverBlockExits() public {
        vm.startPrank(alice);
        IERC20Approve(HOOKR).approve(address(lite), 50 ether);
        lite.lock(50 ether);
        vm.stopPrank();
        skip(LOCK);
        // the reward wallet revokes its allowance and moves its real WIF away
        vm.startPrank(rewardWallet);
        IERC20Approve(WIF).approve(address(lite), 0);
        IERC20Lite(WIF).transfer(bob, BUDGET);
        vm.stopPrank();
        uint256 due = lite.earned(alice);
        vm.prank(alice);
        vm.expectRevert(RixorLite.TransferFailed.selector);
        lite.claim();
        assertEq(lite.earned(alice), due, "nothing lost by the failed claim");
        vm.prank(alice);
        lite.exit();
        assertEq(_bal(HOOKR, alice), 1_000 ether, "exit still returns everything");
    }

    function test_fork_lite_wholeBudgetIsNeverExceeded() public {
        vm.startPrank(alice);
        IERC20Approve(HOOKR).approve(address(lite), 50 ether);
        lite.lock(50 ether);
        skip(DURATION + 1 days);
        uint256 paid = lite.claim();
        vm.stopPrank();
        assertLe(paid, BUDGET);
        assertGe(paid, BUDGET - DURATION, "all but the rate's rounding dust is paid");
        assertEq(_bal(WIF, rewardWallet), BUDGET - paid);
    }
}
