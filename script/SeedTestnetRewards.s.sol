// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";

interface ITestToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

/// @notice TESTNET / LOCAL ONLY. Funds the demo's TEST reward streams from the deployer's tWIF.
///
///   RIXOR_EXPECTED_CHAIN_ID=46630 RIXOR_DEPLOYMENT=deployments/46630.json \
///   RIXOR_CONFIG=deployments/46630-testnet-config.json \
///   node scripts/forge.mjs script script/SeedTestnetRewards.s.sol --rpc-url <testnet> [--broadcast <ledger flags>]
///
/// Approved amounts (fixed, not configurable): 140,000 tWIF over 14 days to the Class A TEST token and 70,000 tWIF
/// over 14 days to the Class B TEST token. Without --broadcast it prints the pre-funding state and the plan.
/// Idempotent: a token that already has a stream from this deployer is skipped, so a re-run after a partial failure
/// never double-funds. Refuses unless the reward token is a valueless TEST token.
contract SeedTestnetRewards is RixorScriptBase {
    using stdJson for string;

    uint256 internal constant AMOUNT_A = 140_000e18;
    uint256 internal constant AMOUNT_B = 70_000e18;
    uint256 internal constant DAYS = 14;

    function run() external {
        uint256 chainId = _pinTestnet();
        _requireRealSender();
        string memory dep = vm.readFile(vm.envString("RIXOR_DEPLOYMENT"));
        string memory cfg = vm.readFile(vm.envString("RIXOR_CONFIG"));
        require(dep.readUint(".chainId") == chainId, "manifest is for another chain");
        RixorRewards rewards = RixorRewards(dep.readAddress(".rewards"));
        RixorLocker locker = RixorLocker(dep.readAddress(".locker"));
        ITestToken reward = ITestToken(dep.readAddress(".wif"));
        require(address(rewards).code.length > 0 && address(locker).code.length > 0, "Rixor contracts not deployed at the manifest addresses");
        require(address(rewards.locker()) == address(locker) && rewards.wif() == address(reward), "manifest wiring mismatch");
        require(cfg.readAddress(".wif") == address(reward), "config and manifest disagree on the reward token");
        require(_endsWith(reward.name(), "(TEST)") && bytes(reward.symbol())[0] == "t", "reward token is not a TEST token");

        address tokenA = cfg.readAddress(".listings[0].token");
        address tokenB = cfg.readAddress(".listings[1].token");
        require(locker.isListed(tokenA) && locker.riskClass(tokenA) == 1, "first listing is not the Class A TEST token");
        require(locker.isListed(tokenB) && locker.riskClass(tokenB) == 2, "second listing is not the Class B TEST token");

        bool needA = !_hasStream(rewards, tokenA);
        bool needB = !_hasStream(rewards, tokenB);
        uint256 needed = (needA ? AMOUNT_A : 0) + (needB ? AMOUNT_B : 0);
        uint256 balance = reward.balanceOf(msg.sender);
        console2.log("deployer tWIF balance", balance / 1e18);
        console2.log("existing streams", rewards.streamCount());
        console2.log("fund Class A token (140,000 tWIF / 14 days)?", needA);
        console2.log("fund Class B token (70,000 tWIF / 14 days)?", needB);
        console2.log("streams start at the next UTC midnight (unix)", ((block.timestamp + 1 days - 1) / 1 days) * 1 days);
        if (needed == 0) {
            console2.log("nothing to do: both streams already exist");
            return;
        }
        require(balance >= needed, "deployer lacks tWIF (it must be the account that received the initial supply)");

        vm.startBroadcast();
        if (reward.allowance(msg.sender, address(rewards)) < needed) reward.approve(address(rewards), needed);
        if (needA) console2.log("stream id (Class A)", rewards.fund(tokenA, AMOUNT_A, DAYS));
        if (needB) console2.log("stream id (Class B)", rewards.fund(tokenB, AMOUNT_B, DAYS));
        vm.stopBroadcast();
    }

    function _hasStream(RixorRewards rewards, address token) internal view returns (bool) {
        uint256 n = rewards.streamCount();
        for (uint256 i = 0; i < n; i++) {
            RixorRewards.Stream memory st = rewards.streamOf(i);
            if (st.token == token && st.funder == msg.sender) return true;
        }
        return false;
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
