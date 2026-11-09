// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {RixorChallenges} from "../contracts/RixorChallenges.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";

interface ISafeView {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Read-only post-deployment checks. Sends nothing.
///
///   RIXOR_EXPECTED_CHAIN_ID=46630 RIXOR_DEPLOYMENT=deployments/46630.json \
///   [RIXOR_CONFIG=deployments/46630-testnet-config.json] \
///   node scripts/forge.mjs script script/VerifyRixorV2.s.sol --rpc-url <url>
///
/// Manifests are written during forge's simulation, before broadcast, so this script must always be run: it proves
/// the contracts actually exist on chain and are wired as the manifest says.
contract VerifyRixorV2 is RixorScriptBase {
    using stdJson for string;

    address internal constant SAFE_L2_150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant SAFE_L2_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    function run() external {
        uint256 chainId = _pin();
        string memory json = vm.readFile(vm.envString("RIXOR_DEPLOYMENT"));
        require(json.readUint(".chainId") == chainId, "manifest is for another chain");
        RixorLocker locker = RixorLocker(json.readAddress(".locker"));
        RixorRewards rewards = RixorRewards(json.readAddress(".rewards"));
        RixorChallenges challenges = RixorChallenges(json.readAddress(".challenges"));
        address wif = json.readAddress(".wif");

        // The Locker has no immutables, so its runtime code must equal this build byte for byte.
        require(address(locker).code.length > 0, "no Locker code at the manifest address (broadcast incomplete?)");
        require(keccak256(address(locker).code) == keccak256(vm.getDeployedCode("RixorLocker.sol:RixorLocker")), "Locker code differs from this build");
        require(address(rewards).code.length > 0 && address(challenges).code.length > 0, "missing Rewards/Challenges code");

        address owner = json.readAddress(".ownerSafe");
        address guardian = json.readAddress(".guardianSafe");
        require(locker.owner() == owner && locker.guardian() == guardian, "roles differ from the manifest");
        require(locker.pendingOwner() == address(0), "unexpected pending owner");
        _checkSafe(owner, "owner");
        _checkSafe(guardian, "guardian");
        require(address(rewards.locker()) == address(locker) && rewards.wif() == wif, "rewards wiring");
        require(address(challenges.locker()) == address(locker) && challenges.wif() == wif, "challenges wiring");
        require(challenges.minHold() == json.readUint(".minHoldSeconds"), "minHold");
        require(!locker.isListed(wif), "reward token must not be lockable");

        string memory cfgPath = vm.envOr("RIXOR_CONFIG", string(""));
        if (bytes(cfgPath).length > 0) _checkConfig(locker, vm.readFile(cfgPath), wif);

        console2.log("paused", locker.paused());
        console2.log("emergencyActivatedAt", locker.emergencyActivatedAt());
        address[] memory listed = locker.listedTokens();
        console2.log("listed tokens", listed.length);
        for (uint256 i = 0; i < listed.length; i++) {
            RixorLocker.TokenConfig memory c = locker.tokenConfig(listed[i]);
            console2.log("  token", listed[i]);
            console2.log("    class / locksEnabled / releasedAt", c.riskClass, c.locksEnabled, c.releasedAt);
            console2.log("    unit / cap", c.unitAmount, c.maxTotalLocked);
        }
        uint256 n = rewards.streamCount();
        console2.log("reward streams", n);
        for (uint256 i = 0; i < n; i++) {
            RixorRewards.Stream memory st = rewards.streamOf(i);
            console2.log("  stream token / amount (whole tokens)", st.token, st.amount / 1e18);
            console2.log("    start day / end day / funder", st.startDay, st.endDay, st.funder);
        }
        console2.log("challenges", challenges.nextChallengeId() - 1);
        console2.log("verification passed");
    }

    function _checkSafe(address safe, string memory role) internal view {
        address singleton = address(uint160(uint256(vm.load(safe, bytes32(0)))));
        require(singleton == SAFE_L2_150 || singleton == SAFE_L2_141, string.concat(role, " is not a known Safe proxy"));
        require(ISafeView(safe).getThreshold() >= 2 && ISafeView(safe).getOwners().length >= 3, string.concat(role, " Safe is not at least 2-of-3"));
    }

    function _checkConfig(RixorLocker locker, string memory cfg, address wif) internal view {
        require(cfg.readAddress(".wif") == wif, "config reward token differs");
        uint256 n;
        while (vm.keyExistsJson(cfg, string.concat(".listings[", vm.toString(n), "]"))) n++;
        require(locker.listedTokens().length == n, "listing count differs from config");
        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".listings[", vm.toString(i), "]");
            address token = cfg.readAddress(string.concat(k, ".token"));
            RixorLocker.TokenConfig memory c = locker.tokenConfig(token);
            require(c.listed, "config token not listed");
            require(c.unitAmount == vm.parseUint(cfg.readString(string.concat(k, ".unitAmount"))), "unit differs from config");
            require(c.maxTotalLocked == vm.parseUint(cfg.readString(string.concat(k, ".maxTotalLocked"))), "cap differs from config");
            require(c.riskClass == cfg.readUint(string.concat(k, ".riskClass")), "class differs from config");
        }
    }
}
