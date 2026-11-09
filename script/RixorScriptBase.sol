// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {RixorSignerChecks} from "./RixorSignerChecks.sol";

/// @notice Shared guards for every Rixor deployment script.
///
/// Chain pinning is checked TWICE, independently:
///   1. `block.chainid` (what the script sees), and
///   2. the RPC's own `eth_chainId`, queried directly with vm.rpc.
/// Both must equal RIXOR_EXPECTED_CHAIN_ID. (1) alone is not enough: `forge script --chain <id>` overrides
/// block.chainid inside the simulation even when the RPC is a different network. Never pass `--chain` to forge script.
abstract contract RixorScriptBase is Script {
    uint256 internal constant MAINNET = 4663;
    uint256 internal constant TESTNET = 46630;
    uint256 internal constant LOCAL = 31337;
    /// @dev Foundry's built-in default sender (used when `--sender` is omitted). Never a real deployer.
    address internal constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev Testnet scripts: only Robinhood Chain testnet or a local rehearsal chain.
    function _pinTestnet() internal returns (uint256 chainId) {
        chainId = _pin();
        require(chainId == TESTNET || chainId == LOCAL, "testnet (46630) or local rehearsal (31337) only");
    }

    function _pin() internal returns (uint256 chainId) {
        chainId = vm.envUint("RIXOR_EXPECTED_CHAIN_ID");
        require(block.chainid == chainId, "block.chainid differs from RIXOR_EXPECTED_CHAIN_ID (do not pass --chain)");
        require(_rpcChainId() == chainId, "the RPC's eth_chainId differs from RIXOR_EXPECTED_CHAIN_ID");
    }

    function _rpcChainId() internal returns (uint256 id) {
        bytes memory raw = vm.rpc("eth_chainId", "[]");
        require(raw.length > 0 && raw.length <= 32, "unexpected eth_chainId response");
        for (uint256 i = 0; i < raw.length; i++) {
            id = (id << 8) | uint8(raw[i]);
        }
    }

    /// @dev Broadcasting scripts must run with an explicit `--sender` (the hardware-wallet deployer).
    function _requireRealSender() internal view {
        require(msg.sender != FOUNDRY_DEFAULT_SENDER, "pass --sender <deployer address> (Foundry's default sender is not a deployer)");
        require(msg.sender.code.length == 0, "the deployer must be a plain EOA (hardware wallet), not a contract or delegated account");
    }

    /// @dev Six distinct signers across both Safes; the broadcasting account (msg.sender and tx.origin) is none of them.
    function _checkSignerSets(address[] memory owners, address[] memory guardians) internal view {
        RixorSignerChecks.check(owners, guardians, msg.sender);
        if (tx.origin != msg.sender) RixorSignerChecks.check(owners, guardians, tx.origin);
    }
}
