// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";

interface IWif {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice MAINNET (4663, only with RIXOR_CONFIRM_MAINNET) or LOCAL MAINNET FORK (31337). Funds the reviewed real
///         $WIF reward streams from the deployer's own WIF.
///
///   RIXOR_EXPECTED_CHAIN_ID=4663 RIXOR_CONFIRM_MAINNET="<sentence>" RIXOR_DEPLOYMENT=deployments/4663.json \
///   RIXOR_CONFIG=deploy/config/mainnet.json \
///   node scripts/forge.mjs script script/SeedMainnetRewards.s.sol --rpc-url <mainnet> --sender <deployer> [--broadcast ...]
///
/// Reads `.streams` from the config: [{ "token": listed token, "amount": WIF wei (string), "days": 7..90 }]. One exact
/// approval for the total, then one fund() per stream, in config order. Refuses unless the reward token is the
/// official $WIF; refuses amounts below the contract minimum or a total above MAX_TOTAL (a typo guard).
/// Idempotent: a token that already has a stream from this deployer is skipped, so a re-run after a partial failure
/// never double-funds. Without --broadcast it prints the plan and the deployer's WIF balance.
contract SeedMainnetRewards is RixorScriptBase {
    using stdJson for string;

    /// @dev Typo guard: the reviewed plan funds far less than this.
    uint256 internal constant MAX_TOTAL = 1_000_000e18;

    function run() external {
        uint256 chainId = _pinMainnet();
        _requireRealSender();
        string memory dep = vm.readFile(vm.envString("RIXOR_DEPLOYMENT"));
        string memory cfg = vm.readFile(vm.envString("RIXOR_CONFIG"));
        require(dep.readUint(".chainId") == chainId, "manifest is for another chain");
        RixorRewards rewards = RixorRewards(dep.readAddress(".rewards"));
        RixorLocker locker = RixorLocker(dep.readAddress(".locker"));
        require(address(rewards).code.length > 0 && address(locker).code.length > 0, "Rixor contracts not deployed at the manifest addresses");
        require(dep.readAddress(".wif") == OFFICIAL_WIF && cfg.readAddress(".wif") == OFFICIAL_WIF, "reward token is not the official WIF");
        require(address(rewards.locker()) == address(locker) && rewards.wif() == OFFICIAL_WIF, "manifest wiring mismatch");
        IWif wif = IWif(OFFICIAL_WIF);
        require(wif.decimals() == 18, "WIF decimals changed");

        StreamPlan[] memory plan = _readStreams(cfg, rewards, locker);
        uint256 n = plan.length;
        uint256 needed;
        uint256 planned;
        for (uint256 i = 0; i < n; i++) {
            planned += plan[i].amount;
            if (plan[i].fundNow) needed += plan[i].amount;
            console2.log("stream token / days / fund now?", plan[i].token, plan[i].days_, plan[i].fundNow);
            console2.log("  amount (whole WIF)", plan[i].amount / 1e18);
        }
        require(planned <= MAX_TOTAL, "planned WIF total above the typo guard");
        uint256 balance = wif.balanceOf(msg.sender);
        console2.log("deployer WIF balance (whole)", balance / 1e18);
        console2.log("WIF needed now (whole)", needed / 1e18);
        console2.log("streams start at the next UTC midnight (unix)", ((block.timestamp + 1 days - 1) / 1 days) * 1 days);
        if (needed == 0) {
            console2.log("nothing to do: every stream already exists");
            return;
        }
        require(balance >= needed, "deployer lacks WIF for the planned streams");

        vm.startBroadcast();
        if (wif.allowance(msg.sender, address(rewards)) < needed) require(wif.approve(address(rewards), needed), "approve failed");
        for (uint256 i = 0; i < n; i++) {
            if (plan[i].fundNow) console2.log("stream id", rewards.fund(plan[i].token, plan[i].amount, plan[i].days_));
        }
        vm.stopBroadcast();
    }

    struct StreamPlan {
        address token;
        uint256 amount;
        uint256 days_;
        bool fundNow;
    }

    function _readStreams(string memory cfg, RixorRewards rewards, RixorLocker locker)
        internal
        view
        returns (StreamPlan[] memory plan)
    {
        uint256 n;
        while (vm.keyExistsJson(cfg, string.concat(".streams[", vm.toString(n), "]"))) n++;
        require(n > 0, "config has no streams");
        plan = new StreamPlan[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".streams[", vm.toString(i), "]");
            StreamPlan memory sp;
            sp.token = cfg.readAddress(string.concat(k, ".token"));
            sp.amount = vm.parseUint(cfg.readString(string.concat(k, ".amount")));
            sp.days_ = cfg.readUint(string.concat(k, ".days"));
            require(locker.isListed(sp.token), "stream token is not listed");
            require(
                sp.amount >= rewards.MIN_FUNDING() && sp.days_ >= rewards.MIN_DAYS() && sp.days_ <= rewards.MAX_DAYS(),
                "stream outside contract bounds"
            );
            for (uint256 j = 0; j < i; j++) require(plan[j].token != sp.token, "one stream per token");
            sp.fundNow = !_hasStream(rewards, sp.token);
            plan[i] = sp;
        }
    }

    function _hasStream(RixorRewards rewards, address token) internal view returns (bool) {
        uint256 count = rewards.streamCount();
        for (uint256 i = 0; i < count; i++) {
            RixorRewards.Stream memory st = rewards.streamOf(i);
            if (st.token == token && st.funder == msg.sender) return true;
        }
        return false;
    }
}
