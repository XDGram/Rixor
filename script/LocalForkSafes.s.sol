// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

interface ISafeFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
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
}

/// @notice LOCAL FORK ONLY. Creates two throwaway 2-of-3 Safe v1.5.0 proxies (owner and guardian) on a local
///         anvil fork of Robinhood Chain started with `--chain-id 31337`, so the deployment dry run has real Safe
///         contracts to point at. Refuses to run on any other chain id. The signer keys are well-known test keys
///         and must never control anything real.
contract LocalForkSafes is Script {
    address internal constant SINGLETON_L2 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address internal constant FALLBACK = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;

    function run() external returns (address ownerSafe, address guardianSafe) {
        require(block.chainid == 31337, "LocalForkSafes runs only on a local fork (chain id 31337)");
        require(SINGLETON_L2.code.length > 0 && FACTORY.code.length > 0, "fork has no Safe v1.5.0 deployment");
        vm.startBroadcast();
        ownerSafe = _safe(1, [uint256(0xA11CE), 0xB0B, 0xCA401]);
        guardianSafe = _safe(2, [uint256(0x6A1), 0x6A2, 0x6A3]);
        vm.stopBroadcast();
        console2.log("LOCAL owner Safe", ownerSafe);
        console2.log("LOCAL guardian Safe", guardianSafe);
    }

    function _safe(uint256 salt, uint256[3] memory keys) internal returns (address) {
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(keys[i]);
        }
        bytes memory init = abi.encodeCall(
            ISafeSetup.setup, (owners, 2, address(0), "", FALLBACK, address(0), 0, payable(address(0)))
        );
        return ISafeFactory(FACTORY).createProxyWithNonce(SINGLETON_L2, init, salt);
    }
}
