// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";

interface ISafeFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external pure returns (bytes memory);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function VERSION() external view returns (string memory);
}

/// @notice ROBINHOOD CHAIN TESTNET (46630) or local rehearsal (31337) only. Creates the Rixor owner and guardian
///         Safes (Safe v1.5.0, canonical factory) for hardware-wallet signers.
///
///   RIXOR_EXPECTED_CHAIN_ID=46630 \
///   RIXOR_OWNER_SIGNERS=0xA..,0xB..,0xC.. RIXOR_GUARDIAN_SIGNERS=0xD..,0xE..,0xF.. \
///   node scripts/forge.mjs script script/CreateTestnetSafes.s.sol --rpc-url <testnet> [--broadcast --ledger ...]
///
/// Without --broadcast it only simulates and prints the exact Safe addresses. Addresses are CREATE2 from the
/// factory and depend only on the signer lists, threshold and the fixed salt, never on who sends the transaction.
/// Checks: signers distinct, non-zero, plain EOAs (no code), at least one guardian signer not an owner signer,
/// the broadcasting deployer is not a signer, threshold 2-of-3.
contract CreateTestnetSafes is RixorScriptBase {
    address internal constant SINGLETON_L2 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // Safe v1.5.0 (SafeL2)
    address internal constant FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant FALLBACK = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;
    uint256 internal constant THRESHOLD = 2;
    uint256 internal constant OWNER_SALT = uint256(keccak256("rixor.testnet.owner-safe.v1"));
    uint256 internal constant GUARDIAN_SALT = uint256(keccak256("rixor.testnet.guardian-safe.v1"));

    function run() external returns (address ownerSafe, address guardianSafe) {
        _pinTestnet();
        _requireRealSender();
        require(SINGLETON_L2.code.length > 0 && FACTORY.code.length > 0 && FALLBACK.code.length > 0, "Safe v1.5.0 not deployed here");
        require(keccak256(bytes(ISafe(SINGLETON_L2).VERSION())) == keccak256("1.5.0"), "unexpected Safe singleton version");

        address[] memory owners = vm.envAddress("RIXOR_OWNER_SIGNERS", ",");
        address[] memory guardians = vm.envAddress("RIXOR_GUARDIAN_SIGNERS", ",");
        _checkSigners(owners, "owner");
        _checkSigners(guardians, "guardian");
        bool independent;
        for (uint256 i = 0; i < guardians.length; i++) {
            if (!_contains(owners, guardians[i])) independent = true;
        }
        require(independent, "at least one guardian signer must not be an owner signer");

        bytes memory ownerInit = _init(owners);
        bytes memory guardianInit = _init(guardians);
        address predictedOwner = _predict(ownerInit, OWNER_SALT);
        address predictedGuardian = _predict(guardianInit, GUARDIAN_SALT);
        console2.log("predicted owner Safe", predictedOwner);
        console2.log("predicted guardian Safe", predictedGuardian);

        vm.startBroadcast();
        ownerSafe = predictedOwner.code.length > 0 ? predictedOwner : ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON_L2, ownerInit, OWNER_SALT);
        guardianSafe = predictedGuardian.code.length > 0 ? predictedGuardian : ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON_L2, guardianInit, GUARDIAN_SALT);
        vm.stopBroadcast();

        require(ownerSafe == predictedOwner && guardianSafe == predictedGuardian, "address prediction mismatch");
        _verify(ownerSafe, owners);
        _verify(guardianSafe, guardians);
        console2.log("owner Safe", ownerSafe);
        console2.log("guardian Safe", guardianSafe);
    }

    function _init(address[] memory signers) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafe.setup, (signers, THRESHOLD, address(0), "", FALLBACK, address(0), 0, payable(address(0))));
    }

    /// @dev Safe v1.5.0 factory: salt = keccak256(keccak256(initializer), saltNonce); CREATE2 over
    ///      proxyCreationCode ++ singleton.
    function _predict(bytes memory initializer, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory code = abi.encodePacked(ISafeFactory(FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON_L2)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, salt, keccak256(code))))));
    }

    function _checkSigners(address[] memory s, string memory role) internal view {
        require(s.length == 3, string.concat(role, ": exactly 3 signers expected (2-of-3)"));
        for (uint256 i = 0; i < s.length; i++) {
            require(s[i] != address(0), string.concat(role, ": zero signer"));
            require(s[i].code.length == 0, string.concat(role, ": signers must be plain EOAs (hardware wallets)"));
            require(s[i] != msg.sender && s[i] != tx.origin, string.concat(role, ": the deployer must not be a signer"));
            for (uint256 j = i + 1; j < s.length; j++) {
                require(s[i] != s[j], string.concat(role, ": duplicate signer"));
            }
        }
    }

    function _verify(address safe, address[] memory expected) internal view {
        require(address(uint160(uint256(vm.load(safe, bytes32(0))))) == SINGLETON_L2, "proxy singleton");
        require(ISafe(safe).getThreshold() == THRESHOLD, "threshold");
        address[] memory got = ISafe(safe).getOwners();
        require(got.length == expected.length, "owner count");
        for (uint256 i = 0; i < expected.length; i++) {
            require(_contains(got, expected[i]), "owner set");
        }
    }

    function _contains(address[] memory list, address a) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }
}
