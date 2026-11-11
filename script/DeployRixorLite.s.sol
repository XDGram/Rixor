// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";
import {RixorLite} from "../contracts/RixorLite.sol";

interface IWifLite {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice MAINNET (4663, only with RIXOR_CONFIRM_MAINNET) or a LOCAL MAINNET FORK (31337). Deploys RixorLite and
///         gives it the reward allowance. Two transactions, both from the deployer, which is also the reward wallet:
///           1. deploy RixorLite(HOOKR, WIF, rewardWallet = deployer, 1,000 WIF over 7 days, 1-day lock, min 10, cap 100,000)
///           2. WIF.approve(RixorLite, 1,000 WIF)
///
///   RIXOR_EXPECTED_CHAIN_ID=4663 RIXOR_CONFIRM_MAINNET="<sentence>" \
///   node scripts/forge.mjs script script/DeployRixorLite.s.sol --rpc-url <mainnet> --sender <deployer> [--broadcast ...]
///
/// Every parameter is a constant here and is pinned again in src/deploy/expected.ts (the Deploy Console rebuilds both
/// transactions from those pins). The deployer must already hold the whole WIF budget, so the rewards are prefunded
/// before the contract exists. RixorLite has no owner, so there are no Safes and no roles to hand over.
contract DeployRixorLite is RixorScriptBase {
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    uint256 internal constant BUDGET = 1_000e18;
    uint256 internal constant DURATION = 7 days;
    uint256 internal constant LOCK_SECONDS = 1 days;
    uint256 internal constant MIN_LOCK = 10e18;
    uint256 internal constant CAP = 100_000e18;

    function run() external returns (address lite) {
        _pinMainnet();
        _requireRealSender();
        address deployer = msg.sender;
        require(HOOKR.code.length > 0 && OFFICIAL_WIF.code.length > 0, "HOOKR or WIF missing on this chain");
        require(IWifLite(OFFICIAL_WIF).decimals() == 18 && IWifLite(HOOKR).decimals() == 18, "unexpected decimals");
        uint256 balance = IWifLite(OFFICIAL_WIF).balanceOf(deployer);
        console2.log("reward wallet (deployer)", deployer);
        console2.log("reward wallet WIF balance (whole)", balance / 1e18);
        require(balance >= BUDGET, "the reward wallet (deployer) must hold the whole WIF budget before deploying");

        vm.startBroadcast();
        RixorLite l = new RixorLite(HOOKR, OFFICIAL_WIF, deployer, BUDGET, DURATION, LOCK_SECONDS, MIN_LOCK, CAP);
        require(IWifLite(OFFICIAL_WIF).approve(address(l), BUDGET), "approve failed");
        vm.stopBroadcast();

        lite = address(l);
        require(l.token() == HOOKR && l.wif() == OFFICIAL_WIF && l.rewardWallet() == deployer, "wiring");
        require(l.budget() == BUDGET && l.rate() == BUDGET / DURATION && l.endTime() - l.startTime() == DURATION, "rewards");
        require(l.lockSeconds() == LOCK_SECONDS && l.minLock() == MIN_LOCK && l.cap() == CAP, "limits");
        require(l.rewardsAvailable() == BUDGET, "rewards are not fully funded");

        string memory key = "lite";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "block", block.number);
        vm.serializeAddress(key, "lite", lite);
        vm.serializeAddress(key, "token", HOOKR);
        vm.serializeAddress(key, "wif", OFFICIAL_WIF);
        string memory out = vm.serializeAddress(key, "rewardWallet", deployer);
        string memory tag = vm.envOr("RIXOR_OUTPUT_TAG", string(""));
        string memory file = string.concat("deployments/", vm.toString(block.chainid), bytes(tag).length > 0 ? string.concat("-", tag) : "", "-lite.json");
        vm.writeJson(out, file);
        console2.log("manifest", file);
        console2.log("RixorLite", lite);
    }
}
