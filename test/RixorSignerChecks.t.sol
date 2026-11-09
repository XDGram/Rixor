// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RixorSignerChecks} from "../script/RixorSignerChecks.sol";

contract SignerChecksHarness {
    function check(address[] memory owners, address[] memory guardians, address deployer) external view {
        RixorSignerChecks.check(owners, guardians, deployer);
    }
}

/// @notice The six-distinct-signer rule shared by CreateTestnetSafes, DeployRixorV2 and VerifyRixorV2.
contract RixorSignerChecksTest is Test {
    SignerChecksHarness internal h;
    address internal o1 = makeAddr("owner1");
    address internal o2 = makeAddr("owner2");
    address internal o3 = makeAddr("owner3");
    address internal g1 = makeAddr("guardian1");
    address internal g2 = makeAddr("guardian2");
    address internal g3 = makeAddr("guardian3");
    address internal deployer = makeAddr("deployer");

    string internal constant SHARE = "owner and guardian Safes must not share any signer (six distinct signers required)";

    function setUp() public {
        h = new SignerChecksHarness();
    }

    function _set(address a, address b, address c) internal pure returns (address[] memory s) {
        s = new address[](3);
        (s[0], s[1], s[2]) = (a, b, c);
    }

    function _owners() internal view returns (address[] memory) {
        return _set(o1, o2, o3);
    }

    function _guardians() internal view returns (address[] memory) {
        return _set(g1, g2, g3);
    }

    function test_sixDistinctSigners_accepted() public view {
        h.check(_owners(), _guardians(), deployer);
    }

    function test_oneSharedSigner_everyPosition_rejected() public {
        address[] memory o = _owners();
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 3; j++) {
                address[] memory g = _guardians();
                g[j] = o[i];
                vm.expectRevert(bytes(SHARE));
                h.check(o, g, deployer);
            }
        }
    }

    function test_twoSharedSigners_rejected() public {
        vm.expectRevert(bytes(SHARE));
        h.check(_owners(), _set(o1, o2, g3), deployer);
        vm.expectRevert(bytes(SHARE));
        h.check(_owners(), _set(g1, o3, o1), deployer);
    }

    function test_threeSharedSigners_rejected() public {
        vm.expectRevert(bytes(SHARE));
        h.check(_owners(), _owners(), deployer);
        vm.expectRevert(bytes(SHARE));
        h.check(_owners(), _set(o3, o1, o2), deployer);
    }

    function test_duplicateWithinOwnerSafe_rejected() public {
        vm.expectRevert(bytes("owner: duplicate signer"));
        h.check(_set(o1, o1, o3), _guardians(), deployer);
        vm.expectRevert(bytes("owner: duplicate signer"));
        h.check(_set(o1, o2, o1), _guardians(), deployer);
    }

    function test_duplicateWithinGuardianSafe_rejected() public {
        vm.expectRevert(bytes("guardian: duplicate signer"));
        h.check(_owners(), _set(g1, g2, g2), deployer);
        vm.expectRevert(bytes("guardian: duplicate signer"));
        h.check(_owners(), _set(g3, g2, g3), deployer);
    }

    function test_deployerAsOwnerSigner_rejected() public {
        for (uint256 i = 0; i < 3; i++) {
            address[] memory o = _owners();
            o[i] = deployer;
            vm.expectRevert(bytes("owner: the deployer must not be a signer"));
            h.check(o, _guardians(), deployer);
        }
    }

    function test_deployerAsGuardianSigner_rejected() public {
        for (uint256 i = 0; i < 3; i++) {
            address[] memory g = _guardians();
            g[i] = deployer;
            vm.expectRevert(bytes("guardian: the deployer must not be a signer"));
            h.check(_owners(), g, deployer);
        }
    }

    function test_zeroSigner_rejected() public {
        vm.expectRevert(bytes("owner: zero signer"));
        h.check(_set(o1, address(0), o3), _guardians(), deployer);
        vm.expectRevert(bytes("guardian: zero signer"));
        h.check(_owners(), _set(address(0), g2, g3), deployer);
    }

    function test_contractSigner_rejected() public {
        vm.etch(o2, hex"6080604052");
        vm.expectRevert(bytes("owner: signers must be plain EOAs (no contract code, no EIP-7702 delegation)"));
        h.check(_owners(), _guardians(), deployer);
    }

    function test_delegatedSigner_rejected() public {
        // EIP-7702 delegation designator: 0xef0100 ++ 20-byte delegate address.
        vm.etch(g3, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        vm.expectRevert(bytes("guardian: signers must be plain EOAs (no contract code, no EIP-7702 delegation)"));
        h.check(_owners(), _guardians(), deployer);
    }

    /// @dev Any overlap between the two sets, at any positions, is rejected.
    function testFuzz_anyOverlap_rejected(uint8 i, uint8 j) public {
        address[] memory o = _owners();
        address[] memory g = _guardians();
        g[j % 3] = o[i % 3];
        vm.expectRevert(bytes(SHARE));
        h.check(o, g, deployer);
    }

    /// @dev Six distinct non-zero EOAs and a separate deployer are always accepted.
    function testFuzz_distinctSets_accepted(uint256 seed) public view {
        address[] memory o = new address[](3);
        address[] memory g = new address[](3);
        for (uint256 k = 0; k < 3; k++) {
            o[k] = address(uint160(uint256(keccak256(abi.encode(seed, "o", k)))));
            g[k] = address(uint160(uint256(keccak256(abi.encode(seed, "g", k)))));
        }
        vm.assume(o[0].code.length == 0 && o[1].code.length == 0 && o[2].code.length == 0);
        vm.assume(g[0].code.length == 0 && g[1].code.length == 0 && g[2].code.length == 0);
        h.check(o, g, address(uint160(uint256(keccak256(abi.encode(seed, "d"))))));
    }
}
