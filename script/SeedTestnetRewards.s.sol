// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";

interface ITestToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice TESTNET / LOCAL ONLY. Funds the demo's TEST reward streams from the broadcaster's tWIF.
///
///   RIXOR_DEPLOYMENT=deployments/46630.json RIXOR_CONFIG=deployments/46630-testnet-config.json \
///   node scripts/forge.mjs script script/SeedTestnetRewards.s.sol --rpc-url <testnet> --broadcast <signer>
///
/// Defaults: 140,000 tWIF over 14 days to the first listed token (Class A), 70,000 tWIF over 14 days to the second
/// (Class B). Refuses unless the reward token is a valueless TEST token ("(TEST)" name, "t" symbol), so real WIF
/// can never be spent by this script.
contract SeedTestnetRewards is Script {
    using stdJson for string;

    function run() external {
        require(block.chainid == 46630 || block.chainid == 31337, "testnet or local only");
        string memory dep = vm.readFile(vm.envString("RIXOR_DEPLOYMENT"));
        string memory cfg = vm.readFile(vm.envString("RIXOR_CONFIG"));
        require(dep.readUint(".chainId") == block.chainid, "manifest is for another chain");
        RixorRewards rewards = RixorRewards(dep.readAddress(".rewards"));
        ITestToken reward = ITestToken(dep.readAddress(".wif"));
        require(address(rewards.wif()) == address(reward), "manifest reward token mismatch");
        require(_endsWith(reward.name(), "(TEST)") && bytes(reward.symbol())[0] == "t", "reward token is not a TEST token");

        address tokenA = cfg.readAddress(".listings[0].token");
        address tokenB = cfg.readAddress(".listings[1].token");
        uint256 amountA = vm.envOr("RIXOR_SEED_A", uint256(140_000e18));
        uint256 amountB = vm.envOr("RIXOR_SEED_B", uint256(70_000e18));
        require(reward.balanceOf(msg.sender) >= amountA + amountB, "broadcaster lacks tWIF (use the deployer that received the initial supply)");

        vm.startBroadcast();
        reward.approve(address(rewards), amountA + amountB);
        uint256 sA = rewards.fund(tokenA, amountA, 14);
        uint256 sB = rewards.fund(tokenB, amountB, 14);
        vm.stopBroadcast();
        console2.log("stream", sA, "funded for", tokenA);
        console2.log("stream", sB, "funded for", tokenB);
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}
