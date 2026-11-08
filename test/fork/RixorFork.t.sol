// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {RixorLocker} from "../../contracts/RixorLocker.sol";
import {RixorChallenges} from "../../contracts/RixorChallenges.sol";
import {IRixorLocker} from "../../contracts/interfaces/IRixorLocker.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
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
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function VERSION() external view returns (string memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @notice Local-fork tests against Robinhood Chain mainnet state. Every test creates a fresh fork at
///         the latest block (the public RPC is not an archive node), deploys the contracts locally, and
///         never broadcasts anything. Safe signer keys below are throwaway test keys, not real signers.
///
///         Run with: npm run test:fork   (RH_MAINNET_RPC_URL overrides the public RPC)
contract RixorForkTest is Test {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address internal constant DOPE = 0xf9e990CCb47806AC9268922BD21Dc9a91C8e8899;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Canonical Safe v1.4.1 deployments, verified on chain 4663.
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    // TEST-ONLY scoring parameters. Production values are set at Gate 2 from a 7-day median.
    uint256 internal constant TEST_WIF_UNIT = 7_000 ether;
    uint256 internal constant TEST_WIF_CAP = 3_500_000 ether;
    uint256 internal constant TEST_DOPE_UNIT = 100_000 ether;
    uint256 internal constant TEST_DOPE_CAP = 50_000_000 ether;
    uint256 internal constant MIN_HOLD = 24 hours; // production default

    // Throwaway keys for local signing only.
    uint256[3] internal ownerKeys = [uint256(0xA11CE), 0xB0B, 0xCA401];
    uint256[3] internal guardianKeys = [uint256(0x6A1), 0x6A2, 0x6A3];

    ISafe internal ownerSafe;
    ISafe internal guardianSafe;
    RixorLocker internal locker;
    RixorChallenges internal challenges;

    address internal alice = makeAddr("fork-alice");
    address internal bob = makeAddr("fork-bob");
    address internal carol = makeAddr("fork-carol");
    address internal sponsorA = makeAddr("fork-sponsorA");
    address internal sponsorB = makeAddr("fork-sponsorB");

    function setUp() public {
        string memory rpc = vm.envOr("RH_MAINNET_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc); // fresh fork at the latest block
        assertEq(block.chainid, CHAIN_ID, "not Robinhood Chain mainnet");
        console2.log("fork block", block.number, "timestamp", block.timestamp);

        ownerSafe = _deploySafe(ownerKeys, 1);
        guardianSafe = _deploySafe(guardianKeys, 2);

        address[] memory tokens = new address[](2);
        tokens[0] = WIF;
        tokens[1] = DOPE;
        uint256[] memory units = new uint256[](2);
        units[0] = TEST_WIF_UNIT;
        units[1] = TEST_DOPE_UNIT;
        uint256[] memory caps = new uint256[](2);
        caps[0] = TEST_WIF_CAP;
        caps[1] = TEST_DOPE_CAP;
        // The Safe is the owner from construction; no EOA ever holds ownership.
        locker = new RixorLocker(WIF, address(ownerSafe), address(guardianSafe), tokens, units, caps);
        challenges = new RixorChallenges(IRixorLocker(address(locker)), MIN_HOLD);

        address[6] memory people = [alice, bob, carol, sponsorA, sponsorB, address(ownerSafe)];
        for (uint256 i = 0; i < people.length; i++) {
            deal(WIF, people[i], 5_000_000 ether);
            deal(DOPE, people[i], 20_000_000 ether);
            if (people[i] == address(ownerSafe)) continue;
            vm.startPrank(people[i]);
            IERC20Like(WIF).approve(address(locker), type(uint256).max);
            IERC20Like(DOPE).approve(address(locker), type(uint256).max);
            IERC20Like(WIF).approve(address(challenges), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ Safe helpers

    function _deploySafe(uint256[3] memory keys, uint256 salt) internal returns (ISafe) {
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(keys[i]);
        }
        bytes memory init =
            abi.encodeCall(ISafe.setup, (owners, 2, address(0), "", SAFE_FALLBACK, address(0), 0, payable(address(0))));
        address proxy = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2_SINGLETON, init, salt);
        ISafe safe = ISafe(proxy);
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);
        assertEq(safe.VERSION(), string("1.4.1"));
        return safe;
    }

    function _txHash(ISafe safe, address to, bytes memory data) internal view returns (bytes32) {
        uint256 n = safe.nonce();
        return safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), n);
    }

    /// @dev Signs with the first `signers` keys (sorted by signer address, as Safe requires) and executes.
    function _signatures(ISafe safe, uint256[3] memory keys, uint256 signers, address to, bytes memory data)
        internal
        view
        returns (bytes memory sigs)
    {
        bytes32 h = _txHash(safe, to, data);
        uint256[] memory ks = new uint256[](signers);
        for (uint256 i = 0; i < signers; i++) {
            ks[i] = keys[i];
        }
        for (uint256 i = 0; i < ks.length; i++) {
            for (uint256 j = i + 1; j < ks.length; j++) {
                if (vm.addr(ks[j]) < vm.addr(ks[i])) (ks[i], ks[j]) = (ks[j], ks[i]);
            }
        }
        for (uint256 i = 0; i < ks.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ks[i], h);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
    }

    function _exec(ISafe safe, uint256[3] memory keys, address to, bytes memory data) internal {
        bytes memory sigs = _signatures(safe, keys, 2, to, data);
        bool ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        assertTrue(ok, "Safe transaction failed");
    }

    function _ownerExec(address to, bytes memory data) internal {
        _exec(ownerSafe, ownerKeys, to, data);
    }

    function _guardianExec(bytes memory data) internal {
        _exec(guardianSafe, guardianKeys, address(locker), data);
    }

    function _params(uint64 joinIn, uint64 endIn) internal view returns (RixorChallenges.CreateParams memory p) {
        p.tokens = new address[](2);
        p.tokens[0] = DOPE;
        p.tokens[1] = WIF;
        p.minTier = 0;
        p.minUnitsPerEntry = 1;
        p.joinDeadline = uint64(block.timestamp) + joinIn;
        p.endTime = uint64(block.timestamp) + endIn;
        p.goalPoints = 0;
        p.maxParticipants = 200;
        p.title = "Fork lifecycle";
        p.description = "Local fork test";
    }

    // ------------------------------------------------------------------ tests

    function test_fork_environment() public view {
        assertEq(IERC20Like(WIF).decimals(), 18);
        assertEq(IERC20Like(DOPE).decimals(), 18);
        assertGt(IERC20Like(WIF).totalSupply(), 0);
        assertGt(SAFE_L2_SINGLETON.code.length, 0);
        assertGt(SAFE_FACTORY.code.length, 0);
        assertTrue(locker.isListed(WIF) && locker.isListed(DOPE));
        assertEq(locker.owner(), address(ownerSafe));
        assertEq(locker.guardian(), address(guardianSafe));
        assertEq(challenges.wif(), WIF);
    }

    // Lifecycle state shared between phases (keeps each function within the legacy-codegen stack limit).
    uint256 internal pa;
    uint256 internal pb;
    uint256 internal pc;
    uint256 internal cid;
    uint256 internal sid;
    uint256 internal fid;

    function test_fork_fullLifecycle() public {
        _phaseLock();
        _phaseCreate();
        _phaseJoin();
        _phaseExitsAndSettle();
        _phaseClaimsRefunds();
        _phaseSweepAndFinalExit();
    }

    function _phaseLock() internal {
        // Lock: WIF Diamond, DOPE Committed, DOPE Flexible.
        vm.prank(alice);
        pa = locker.lock(WIF, 10 * TEST_WIF_UNIT, 2, 90);
        vm.prank(bob);
        pb = locker.lock(DOPE, 10 * TEST_DOPE_UNIT, 1, 30);
        vm.prank(carol);
        pc = locker.lock(DOPE, 5 * TEST_DOPE_UNIT, 0, 0);
        assertEq(IERC20Like(WIF).balanceOf(address(locker)), 10 * TEST_WIF_UNIT, "real WIF transfer exact");
        assertEq(IERC20Like(DOPE).balanceOf(address(locker)), 15 * TEST_DOPE_UNIT, "real DOPE transfer exact");
    }

    function _phaseCreate() internal {
        // Community challenge + co-sponsor.
        vm.prank(sponsorA);
        cid = challenges.createChallenge(_params(1 days, 2 days), 300_000 ether);
        vm.prank(sponsorB);
        challenges.sponsor(cid, 100_000 ether);

        // Season challenge created and funded by the 2-of-3 Safe.
        _ownerExec(WIF, abi.encodeCall(IERC20Like.approve, (address(challenges), 1_000_000 ether)));
        sid = challenges.nextChallengeId();
        _ownerExec(
            address(challenges),
            abi.encodeCall(RixorChallenges.createSeason, (_params(1 days, 2 days), 1_000_000 ether))
        );
        assertTrue(challenges.getChallenge(sid).isSeason);
        assertEq(challenges.contributionOf(sid, address(ownerSafe)), 1_000_000 ether);

        // A failing challenge (goal unreachable) to exercise refunds.
        RixorChallenges.CreateParams memory hard = _params(1 days, 2 days);
        hard.goalPoints = 10_000_000;
        vm.prank(sponsorB);
        fid = challenges.createChallenge(hard, 150_000 ether);
    }

    function _phaseJoin() internal {
        // Everyone joins the community challenge; alice and bob also stack the Season lane.
        vm.prank(alice);
        challenges.join(cid, pa, address(0));
        vm.prank(bob);
        challenges.join(cid, pb, alice);
        vm.prank(carol);
        challenges.join(cid, pc, address(0));
        vm.prank(alice);
        challenges.join(sid, pa, address(0));
        vm.prank(bob);
        challenges.join(sid, pb, address(0));
        // A position cannot enter a second running community challenge.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorChallenges.LaneOccupied.selector, cid));
        challenges.join(fid, pa, address(0));
        assertEq(challenges.entryOf(cid, alice).points, 500_000);
        assertEq(challenges.entryOf(cid, bob).points, 150_000);
        assertEq(challenges.entryOf(cid, carol).points, 25_000);
    }

    function _phaseExitsAndSettle() internal {
        // Carol exits one second early (Flexible, no fee) and is disqualified.
        uint64 end = challenges.getChallenge(cid).endTime;
        vm.warp(end - 1);
        vm.prank(carol);
        locker.exit(pc, 0);

        // Bob exits his Committed position after the challenge but before term end: fee burned to 0xdead.
        vm.warp(end + 1);
        uint256 deadBefore = IERC20Like(DOPE).balanceOf(DEAD);
        (, uint256 feeBps) = locker.exitTerms(pb);
        vm.prank(bob);
        locker.exit(pb, feeBps);
        uint256 fee = 10 * TEST_DOPE_UNIT * feeBps / 10_000;
        assertGt(fee, 0);
        assertEq(IERC20Like(DOPE).balanceOf(DEAD) - deadBefore, fee, "early-exit fee burned to 0xdead");
        assertEq(locker.retainedFees(DOPE), 0);

        // Settle (permissionless, batched).
        challenges.settle(cid, 1);
        challenges.settle(cid, 10);
        challenges.settle(sid, 10);
        challenges.settle(fid, 10);
        assertTrue(challenges.getChallenge(cid).success);
        assertTrue(challenges.entryOf(cid, bob).qualified);
        assertFalse(challenges.entryOf(cid, carol).qualified);
        assertFalse(challenges.getChallenge(fid).success);
    }

    function _phaseClaimsRefunds() internal {
        uint256 pool = 400_000 ether;
        uint256 seasonPool = 1_000_000 ether;
        vm.prank(alice);
        assertEq(challenges.claim(cid), pool * 500_000 / 650_000);
        vm.prank(alice);
        assertEq(challenges.claim(sid), seasonPool * 500_000 / 650_000);
        vm.prank(bob);
        assertEq(challenges.claim(sid), seasonPool * 150_000 / 650_000);
        // Bob does not claim the community pool; it is swept back to sponsors pro-rata.
        vm.prank(sponsorB);
        assertEq(challenges.refund(fid), 150_000 ether);
    }

    function _phaseSweepAndFinalExit() internal {
        vm.warp(block.timestamp + 30 days + 1);
        uint256 remaining = challenges.getChallenge(cid).escrow;
        vm.prank(sponsorA);
        uint256 sa = challenges.sweep(cid);
        vm.prank(sponsorB);
        uint256 sb = challenges.sweep(cid);
        assertEq(sa, remaining * 300_000 / 400_000);
        assertEq(sb, remaining * 100_000 / 400_000);
        assertLe(sa + sb, remaining);
        // Season dust returns to the Safe.
        uint256 safeBefore = IERC20Like(WIF).balanceOf(address(ownerSafe));
        vm.prank(address(ownerSafe));
        uint256 ss = challenges.sweep(sid);
        assertEq(IERC20Like(WIF).balanceOf(address(ownerSafe)) - safeBefore, ss);

        // Diamond position completes its term and exits in full.
        vm.warp(locker.positionOf(pa).endsAt);
        uint256 before = IERC20Like(WIF).balanceOf(alice);
        vm.prank(alice);
        locker.exit(pa, 0);
        assertEq(IERC20Like(WIF).balanceOf(alice) - before, 10 * TEST_WIF_UNIT);

        assertEq(challenges.totalEscrow(), IERC20Like(WIF).balanceOf(address(challenges)));
        assertLt(challenges.totalEscrow(), 10, "only rounding dust remains");
        assertEq(IERC20Like(DOPE).balanceOf(address(locker)), 0);
        assertEq(IERC20Like(WIF).balanceOf(address(locker)), 0);
    }

    function test_fork_safeAdministrationAndEmergency() public {
        // A single signature is not enough for the 2-of-3 Safe.
        bytes memory data = abi.encodeCall(RixorLocker.proposeUnitAmount, (DOPE, TEST_DOPE_UNIT * 12 / 10));
        bytes memory oneSig = _signatures(ownerSafe, ownerKeys, 1, address(locker), data);
        vm.expectRevert(bytes("GS020"));
        ownerSafe.execTransaction(address(locker), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), oneSig);

        // Timelocked unit change via the Safe; executable by anyone after 48h and the 7-day interval.
        _ownerExec(address(locker), data);
        vm.expectRevert();
        locker.executeUnitAmount(DOPE);
        vm.warp(block.timestamp + 7 days);
        locker.executeUnitAmount(DOPE);
        assertEq(locker.unitAmount(DOPE), TEST_DOPE_UNIT * 12 / 10);

        // Running challenge with a Diamond participant.
        vm.prank(alice);
        uint256 dpos = locker.lock(DOPE, 10 * TEST_DOPE_UNIT, 2, 90);
        vm.prank(sponsorA);
        uint256 runningId = challenges.createChallenge(_params(1 days, 2 days), 200_000 ether);
        vm.prank(alice);
        challenges.join(runningId, dpos, address(0));

        // Emergency through the guardian Safe.
        _guardianExec(abi.encodeCall(RixorLocker.activateEmergency, ()));
        assertGt(locker.emergencyActivatedAt(), 0);
        assertTrue(challenges.isCancelled(runningId));

        // The owner Safe cannot undo it.
        bytes memory unpause = abi.encodeCall(RixorLocker.unpause, ());
        bytes memory sigs = _signatures(ownerSafe, ownerKeys, 2, address(locker), unpause);
        vm.expectRevert(bytes("GS013")); // inner call reverted (EmergencyActive)
        ownerSafe.execTransaction(address(locker), 0, unpause, 0, 0, 0, 0, address(0), payable(address(0)), sigs);

        // Exits and refunds remain available; Diamond exits early without a fee.
        uint256 before = IERC20Like(DOPE).balanceOf(alice);
        vm.prank(alice);
        locker.exit(dpos, 0);
        assertEq(IERC20Like(DOPE).balanceOf(alice) - before, 10 * TEST_DOPE_UNIT);
        vm.prank(sponsorA);
        assertEq(challenges.refund(runningId), 200_000 ether);
        assertEq(challenges.totalEscrow(), 0);
    }
}
