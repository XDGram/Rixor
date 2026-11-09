// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {RixorScriptBase} from "./RixorScriptBase.sol";

interface ISafeFactoryM {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external pure returns (bytes memory);
}

interface ISafeM {
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

/// @notice ROBINHOOD CHAIN MAINNET (4663, only with RIXOR_CONFIRM_MAINNET) or a LOCAL mainnet fork (31337).
///         Creates the Rixor owner and guardian Safes (Safe v1.5.0, canonical factory, 2-of-3 each).
///
///   RIXOR_EXPECTED_CHAIN_ID=4663 RIXOR_CONFIRM_MAINNET="<sentence>" \
///   RIXOR_OWNER_SIGNERS=0xA..,0xB..,0xC.. RIXOR_GUARDIAN_SIGNERS=0xD..,0xE..,0xF.. \
///   node scripts/forge.mjs script script/CreateMainnetSafes.s.sol --rpc-url <mainnet> --sender <deployer> [--broadcast ...]
///
/// Identical to CreateTestnetSafes except for the chain guard and the salts (mainnet Safes never share an address
/// with the testnet ones). Addresses are CREATE2 from the factory and depend only on the signer lists, threshold,
/// fallback handler and salt, never on who sends the transaction. Checks (RixorSignerChecks): six distinct signers
/// across both Safes, non-zero, plain EOAs (no code, no EIP-7702 delegation), the deployer is not a signer.
/// Unlike the testnet script it never reuses a pre-existing Safe: code at a predicted address halts the run, because
/// an unexpected Safe means the reviewed plan no longer describes the chain and must be re-planned from scratch.
contract CreateMainnetSafes is RixorScriptBase {
    address internal constant SINGLETON_L2 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e; // Safe v1.5.0 (SafeL2)
    address internal constant FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant FALLBACK = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;
    uint256 internal constant THRESHOLD = 2;
    uint256 internal constant OWNER_SALT = uint256(keccak256("rixor.mainnet.owner-safe.v1"));
    uint256 internal constant GUARDIAN_SALT = uint256(keccak256("rixor.mainnet.guardian-safe.v1"));

    function run() external returns (address ownerSafe, address guardianSafe) {
        _pinMainnet();
        _requireRealSender();
        require(SINGLETON_L2.code.length > 0 && FACTORY.code.length > 0 && FALLBACK.code.length > 0, "Safe v1.5.0 not deployed here");
        require(keccak256(bytes(ISafeM(SINGLETON_L2).VERSION())) == keccak256("1.5.0"), "unexpected Safe singleton version");

        address[] memory owners = vm.envAddress("RIXOR_OWNER_SIGNERS", ",");
        address[] memory guardians = vm.envAddress("RIXOR_GUARDIAN_SIGNERS", ",");
        require(owners.length == 3 && guardians.length == 3, "exactly 3 signers per Safe expected (2-of-3)");
        _checkSignerSets(owners, guardians);

        bytes memory ownerInit = _init(owners);
        bytes memory guardianInit = _init(guardians);
        address predictedOwner = _predict(ownerInit, OWNER_SALT);
        address predictedGuardian = _predict(guardianInit, GUARDIAN_SALT);
        console2.log("predicted owner Safe", predictedOwner);
        console2.log("predicted guardian Safe", predictedGuardian);
        require(predictedOwner.code.length == 0, "HALT: the owner Safe address already has code; re-plan from scratch");
        require(predictedGuardian.code.length == 0, "HALT: the guardian Safe address already has code; re-plan from scratch");

        vm.startBroadcast();
        ownerSafe = ISafeFactoryM(FACTORY).createProxyWithNonce(SINGLETON_L2, ownerInit, OWNER_SALT);
        guardianSafe = ISafeFactoryM(FACTORY).createProxyWithNonce(SINGLETON_L2, guardianInit, GUARDIAN_SALT);
        vm.stopBroadcast();

        require(ownerSafe == predictedOwner && guardianSafe == predictedGuardian, "address prediction mismatch");
        _verify(ownerSafe, owners);
        _verify(guardianSafe, guardians);
        console2.log("owner Safe", ownerSafe);
        console2.log("guardian Safe", guardianSafe);
    }

    function _init(address[] memory signers) internal pure returns (bytes memory) {
        return abi.encodeCall(ISafeM.setup, (signers, THRESHOLD, address(0), "", FALLBACK, address(0), 0, payable(address(0))));
    }

    /// @dev Safe v1.5.0 factory: salt = keccak256(keccak256(initializer), saltNonce); CREATE2 over
    ///      proxyCreationCode ++ singleton.
    function _predict(bytes memory initializer, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes memory code = abi.encodePacked(ISafeFactoryM(FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON_L2)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, salt, keccak256(code))))));
    }

    function _verify(address safe, address[] memory expected) internal view {
        require(address(uint160(uint256(vm.load(safe, bytes32(0))))) == SINGLETON_L2, "proxy singleton");
        require(ISafeM(safe).getThreshold() == THRESHOLD, "threshold");
        address[] memory got = ISafeM(safe).getOwners();
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
