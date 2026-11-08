// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {RixorChallenges} from "../contracts/RixorChallenges.sol";

/// @notice Read-only post-deployment checks. Sends nothing.
///
///   RIXOR_DEPLOYMENT=deployments/<chainId>.json forge script script/VerifyRixorV2.s.sol --rpc-url <url>
contract VerifyRixorV2 is Script {
    using stdJson for string;

    function run() external view {
        string memory json = vm.readFile(vm.envString("RIXOR_DEPLOYMENT"));
        require(json.readUint(".chainId") == block.chainid, "manifest is for another chain");
        RixorLocker locker = RixorLocker(json.readAddress(".locker"));
        RixorRewards rewards = RixorRewards(json.readAddress(".rewards"));
        RixorChallenges challenges = RixorChallenges(json.readAddress(".challenges"));
        address wif = json.readAddress(".wif");

        // The Locker has no immutables, so its runtime code must equal this build byte for byte.
        require(keccak256(address(locker).code) == keccak256(vm.getDeployedCode("RixorLocker.sol:RixorLocker")), "Locker code differs from this build");
        require(address(rewards).code.length > 0 && address(challenges).code.length > 0, "missing code");

        require(locker.owner() == json.readAddress(".ownerSafe"), "owner");
        require(locker.guardian() == json.readAddress(".guardianSafe"), "guardian");
        require(locker.owner().code.length > 0 && locker.guardian().code.length > 0, "roles must be contracts");
        require(locker.pendingOwner() == address(0), "unexpected pending owner");
        require(address(rewards.locker()) == address(locker) && rewards.wif() == wif, "rewards wiring");
        require(address(challenges.locker()) == address(locker) && challenges.wif() == wif, "challenges wiring");
        require(challenges.minHold() == json.readUint(".minHoldSeconds"), "minHold");
        require(!locker.isListed(wif), "reward token must not be lockable");

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
        console2.log("reward streams", rewards.streamCount());
        console2.log("challenges", challenges.nextChallengeId() - 1);
        console2.log("verification passed");
    }
}
