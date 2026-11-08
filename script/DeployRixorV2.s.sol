// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {RixorLocker} from "../contracts/RixorLocker.sol";
import {RixorRewards} from "../contracts/RixorRewards.sol";
import {RixorChallenges} from "../contracts/RixorChallenges.sol";
import {IRixorLocker} from "../contracts/interfaces/IRixorLocker.sol";

interface ISafeView {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Deploys RixorLocker, RixorRewards and RixorChallenges from a JSON config.
///
///   RIXOR_CONFIG=deploy/config/<file>.json RIXOR_OWNER_SAFE=0x… RIXOR_GUARDIAN_SAFE=0x… \
///   forge script script/DeployRixorV2.s.sol --rpc-url <url> --broadcast <signer options>
///
/// Guards (the script reverts before broadcasting anything if one fails):
///   - chain must be a local fork (31337), Robinhood Chain testnet (46630) or, only with an explicit written
///     confirmation string in RIXOR_CONFIRM_MAINNET, Robinhood Chain mainnet (4663);
///   - owner and guardian must be deployed contracts, must differ, and on a real chain must be multisigs with a
///     threshold of at least 2;
///   - the reward token must be a contract and must not appear in the listings.
/// The script sets no gas limits: every transaction uses the node's eth_estimateGas.
contract DeployRixorV2 is Script {
    using stdJson for string;

    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46630;
    uint256 internal constant LOCAL = 31337;
    string internal constant MAINNET_CONFIRMATION =
        "I have written authorisation to deploy Rixor V2 to Robinhood Chain mainnet";

    struct Deployed {
        address locker;
        address rewards;
        address challenges;
    }

    function run() external returns (Deployed memory d) {
        _guardChain();
        string memory configPath = vm.envString("RIXOR_CONFIG");
        string memory json = vm.readFile(configPath);
        address owner = vm.envAddress("RIXOR_OWNER_SAFE");
        address guardian = vm.envAddress("RIXOR_GUARDIAN_SAFE");
        address wif = json.readAddress(".wif");
        uint256 minHold = json.readUint(".minHoldSeconds");
        RixorLocker.Listing[] memory listings = _listings(json, wif);

        _guardRoles(owner, guardian);
        require(wif.code.length > 0, "reward token has no code on this chain");

        console2.log("chain", block.chainid);
        console2.log("owner Safe", owner);
        console2.log("guardian Safe", guardian);
        console2.log("reward token (WIF)", wif);
        console2.log("initial listings", listings.length);

        vm.startBroadcast();
        RixorLocker locker = new RixorLocker(owner, guardian, listings);
        RixorRewards rewards = new RixorRewards(IRixorLocker(address(locker)), wif);
        RixorChallenges challenges = new RixorChallenges(IRixorLocker(address(locker)), wif, minHold);
        vm.stopBroadcast();

        d = Deployed(address(locker), address(rewards), address(challenges));
        _checkWiring(d, owner, guardian, wif, minHold, listings);
        _writeManifest(d, owner, guardian, wif, minHold, configPath, listings.length);
    }

    function _guardChain() internal view {
        if (block.chainid == MAINNET) {
            require(
                keccak256(bytes(vm.envOr("RIXOR_CONFIRM_MAINNET", string("")))) == keccak256(bytes(MAINNET_CONFIRMATION)),
                "mainnet deployment requires RIXOR_CONFIRM_MAINNET with the exact written-authorisation sentence"
            );
        } else {
            require(block.chainid == TESTNET || block.chainid == LOCAL, "unsupported chain id");
        }
    }

    function _guardRoles(address owner, address guardian) internal view {
        require(_isContract(owner), "owner must be a deployed Safe (contract, not an EOA or EIP-7702-delegated EOA)");
        require(_isContract(guardian), "guardian must be a deployed Safe (contract, not an EOA or EIP-7702-delegated EOA)");
        require(owner != guardian, "owner and guardian must be different Safes");
        if (block.chainid != LOCAL) {
            require(ISafeView(owner).getThreshold() >= 2, "owner Safe threshold must be at least 2");
            require(ISafeView(guardian).getThreshold() >= 2, "guardian Safe threshold must be at least 2");
        }
    }

    function _isContract(address a) internal view returns (bool) {
        bytes memory c = a.code;
        if (c.length == 0) return false;
        return !(c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00);
    }

    function _listings(string memory json, address wif) internal view returns (RixorLocker.Listing[] memory out) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".listings[", vm.toString(n), "]"))) n++;
        out = new RixorLocker.Listing[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory k = string.concat(".listings[", vm.toString(i), "]");
            address token = json.readAddress(string.concat(k, ".token"));
            require(token != wif, "the reward token must not be listed as a lockable asset");
            out[i] = RixorLocker.Listing({
                token: token,
                unitAmount: vm.parseUint(json.readString(string.concat(k, ".unitAmount"))),
                maxTotalLocked: vm.parseUint(json.readString(string.concat(k, ".maxTotalLocked"))),
                riskClass: uint8(json.readUint(string.concat(k, ".riskClass")))
            });
        }
    }

    function _checkWiring(
        Deployed memory d,
        address owner,
        address guardian,
        address wif,
        uint256 minHold,
        RixorLocker.Listing[] memory listings
    ) internal view {
        RixorLocker locker = RixorLocker(d.locker);
        require(locker.owner() == owner && locker.guardian() == guardian, "roles");
        require(!locker.paused() && locker.emergencyActivatedAt() == 0, "fresh state");
        require(address(RixorRewards(d.rewards).locker()) == d.locker && RixorRewards(d.rewards).wif() == wif, "rewards wiring");
        RixorChallenges c = RixorChallenges(d.challenges);
        require(address(c.locker()) == d.locker && c.wif() == wif && c.minHold() == minHold, "challenges wiring");
        require(locker.listedTokens().length == listings.length, "listings");
        for (uint256 i = 0; i < listings.length; i++) {
            require(locker.riskClass(listings[i].token) == listings[i].riskClass, "risk class");
            require(locker.checkpointCount(listings[i].token) == 1, "genesis checkpoint");
        }
    }

    function _writeManifest(
        Deployed memory d,
        address owner,
        address guardian,
        address wif,
        uint256 minHold,
        string memory configPath,
        uint256 listingCount
    ) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "block", block.number);
        vm.serializeAddress(key, "locker", d.locker);
        vm.serializeAddress(key, "rewards", d.rewards);
        vm.serializeAddress(key, "challenges", d.challenges);
        vm.serializeAddress(key, "ownerSafe", owner);
        vm.serializeAddress(key, "guardianSafe", guardian);
        vm.serializeAddress(key, "wif", wif);
        vm.serializeUint(key, "minHoldSeconds", minHold);
        vm.serializeUint(key, "initialListings", listingCount);
        string memory out = vm.serializeString(key, "config", configPath);
        string memory file = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, file);
        console2.log("manifest", file);
        console2.log("RixorLocker", d.locker);
        console2.log("RixorRewards", d.rewards);
        console2.log("RixorChallenges", d.challenges);
    }
}
