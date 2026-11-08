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
///   RIXOR_EXPECTED_CHAIN_ID=46630 RIXOR_CONFIG=deploy/config/<file>.json RIXOR_OWNER_SAFE=0x… RIXOR_GUARDIAN_SAFE=0x… \
///   forge script script/DeployRixorV2.s.sol --rpc-url <url> --broadcast <signer options>
///
/// Guards (the script reverts before broadcasting anything if one fails):
///   - chain must be a local fork (31337), Robinhood Chain testnet (46630) or, only with an explicit written
///     confirmation string in RIXOR_CONFIRM_MAINNET, Robinhood Chain mainnet (4663);
///   - owner and guardian must be genuine Safe v1.5.0/v1.4.1 proxies (not EOAs or EIP-7702-delegated EOAs) with
///     at least 3 signers and threshold >= 2, must differ, must not share every signer, and must not include the
///     deployer as a signer;
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
        // Mandatory pin: the operator states the intended chain; a mis-pointed RPC fails before anything is signed.
        require(block.chainid == vm.envUint("RIXOR_EXPECTED_CHAIN_ID"), "RPC chain id differs from RIXOR_EXPECTED_CHAIN_ID");
        if (block.chainid == MAINNET) {
            require(
                keccak256(bytes(vm.envOr("RIXOR_CONFIRM_MAINNET", string("")))) == keccak256(bytes(MAINNET_CONFIRMATION)),
                "mainnet deployment requires RIXOR_CONFIRM_MAINNET with the exact written-authorisation sentence"
            );
        } else {
            require(block.chainid == TESTNET || block.chainid == LOCAL, "unsupported chain id");
        }
    }

    // Safe singletons verified on Robinhood Chain mainnet and testnet (identical code on both, Nov 2026).
    address internal constant SAFE_L2_150 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant SAFE_L2_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    /// @dev Owner and guardian must be genuine Safe proxies (storage slot 0 = a known Safe singleton) with at least
    ///      3 signers and a threshold of at least 2, must differ, must not share every signer, and must not be
    ///      controlled by the deployer. Applies on every chain, including the local fork dry run.
    function _guardRoles(address owner, address guardian) internal view {
        require(_isContract(owner), "owner must be a deployed Safe (contract, not an EOA or EIP-7702-delegated EOA)");
        require(_isContract(guardian), "guardian must be a deployed Safe (contract, not an EOA or EIP-7702-delegated EOA)");
        require(owner != guardian, "owner and guardian must be different Safes");
        address[] memory ownerSigners = _checkSafe(owner, "owner");
        address[] memory guardianSigners = _checkSafe(guardian, "guardian");
        bool independent;
        for (uint256 i = 0; i < guardianSigners.length; i++) {
            if (!_contains(ownerSigners, guardianSigners[i])) independent = true;
        }
        require(independent, "at least one guardian signer must not be an owner signer");
    }

    function _checkSafe(address safe, string memory role) internal view returns (address[] memory signers) {
        address singleton = address(uint160(uint256(vm.load(safe, bytes32(0)))));
        require(singleton == SAFE_L2_150 || singleton == SAFE_L2_141, string.concat(role, " is not a known Safe v1.5.0/v1.4.1 proxy"));
        signers = ISafeView(safe).getOwners();
        uint256 threshold = ISafeView(safe).getThreshold();
        require(signers.length >= 3, string.concat(role, " Safe needs at least 3 signers"));
        require(threshold >= 2 && threshold <= signers.length, string.concat(role, " Safe threshold must be at least 2"));
        // The deployer (the broadcasting account) must not be able to act as a Safe signer.
        require(!_contains(signers, msg.sender) && !_contains(signers, tx.origin), string.concat(role, " Safe must not include the deployer as a signer"));
        console2.log(string.concat(role, " Safe: signers / threshold"), signers.length, threshold);
    }

    function _contains(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
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
        // RIXOR_OUTPUT_TAG (e.g. "plan") keeps rehearsal output apart from a real deployment's manifest.
        string memory tag = vm.envOr("RIXOR_OUTPUT_TAG", string(""));
        string memory file = string.concat("deployments/", vm.toString(block.chainid), bytes(tag).length > 0 ? string.concat("-", tag) : "", ".json");
        vm.writeJson(out, file);
        console2.log("manifest", file);
        console2.log("RixorLocker", d.locker);
        console2.log("RixorRewards", d.rewards);
        console2.log("RixorChallenges", d.challenges);
    }
}
