// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Signer-set rules for the Rixor owner and guardian Safes, shared by Safe creation, deployment and
///         verification (and mirrored in scripts/lib/signer-sets.mjs for planning and preflight).
///
/// The six signer addresses must be COMPLETELY DISTINCT across both Safes:
///   - no zero address;
///   - no duplicate inside either Safe;
///   - no address that is both an owner signer and a guardian signer (not even one);
///   - every signer is a plain EOA: no contract code and no EIP-7702 delegation (both show as code);
///   - the deployer is none of the signers.
/// Signer counts and thresholds are checked by the callers (Safe creation: exactly 2-of-3).
library RixorSignerChecks {
    function check(address[] memory owners, address[] memory guardians, address deployer) internal view {
        _checkSet(owners, "owner", deployer);
        _checkSet(guardians, "guardian", deployer);
        for (uint256 i = 0; i < owners.length; i++) {
            for (uint256 j = 0; j < guardians.length; j++) {
                require(owners[i] != guardians[j], "owner and guardian Safes must not share any signer (six distinct signers required)");
            }
        }
    }

    function _checkSet(address[] memory s, string memory role, address deployer) private view {
        for (uint256 i = 0; i < s.length; i++) {
            require(s[i] != address(0), string.concat(role, ": zero signer"));
            require(s[i].code.length == 0, string.concat(role, ": signers must be plain EOAs (no contract code, no EIP-7702 delegation)"));
            require(s[i] != deployer, string.concat(role, ": the deployer must not be a signer"));
            for (uint256 j = i + 1; j < s.length; j++) {
                require(s[i] != s[j], string.concat(role, ": duplicate signer"));
            }
        }
    }
}
