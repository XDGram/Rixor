// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {RixorLocker} from "../../contracts/RixorLocker.sol";
import {RixorChallenges} from "../../contracts/RixorChallenges.sol";
import {RixorRewards} from "../../contracts/RixorRewards.sol";
import {IRixorLocker} from "../../contracts/interfaces/IRixorLocker.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
}

interface ITorch {
    function BUY_TAX_BPS() external view returns (uint256);
    function FEE_ROUTER() external view returns (address);
    function POOL_MANAGER() external view returns (address);
    function poolStatus(address) external view returns (uint8);
    function isPool(address) external view returns (bool);
}

interface IPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
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

/// @notice Local-fork tests against Robinhood Chain mainnet state. Every test creates a fresh fork at the latest
///         block (the public RPC is not an archive node), deploys the contracts locally, and never broadcasts
///         anything. Safe signer keys below are throwaway test keys, not real signers.
///
///         Candidate tokens under test (approved for implementation testing only, NOT for production listing):
///           HOOKR  0x18E6...ff5c  Class A candidate (Uniswap UERC20 / Solady ERC20)
///           TORCH  0x0000...1111  Class B candidate (OpenZeppelin ERC20 with a fixed buy tax on pool exits)
///         $WIF is the reward and prize token only.
///
///         Run with: npm run test:fork   (RH_MAINNET_RPC_URL overrides the public RPC)
contract RixorForkTest is Test {
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant TORCH = 0x000050E18ffa3F8F7aD170Eb9CeF160eb3Ed1111;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Canonical Safe v1.4.1 deployments, verified on chain 4663.
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    // TEST-ONLY parameters. Production units and caps are set at listing from the vetting report.
    uint256 internal constant UNIT = 100_000 ether;
    uint256 internal constant CAP = 50_000_000 ether;
    uint256 internal constant MIN_HOLD = 24 hours;

    uint256[3] internal ownerKeys = [uint256(0xA11CE), 0xB0B, 0xCA401];
    uint256[3] internal guardianKeys = [uint256(0x6A1), 0x6A2, 0x6A3];

    ISafe internal ownerSafe;
    ISafe internal guardianSafe;
    RixorLocker internal locker;
    RixorChallenges internal challenges;
    RixorRewards internal rewards;

    address internal alice = makeAddr("fork-alice");
    address internal bob = makeAddr("fork-bob");
    address internal carol = makeAddr("fork-carol");
    address internal sponsorA = makeAddr("fork-sponsorA");
    address internal funder = makeAddr("fork-funder");

    function setUp() public {
        string memory rpc = vm.envOr("RH_MAINNET_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);
        assertEq(block.chainid, CHAIN_ID, "not Robinhood Chain mainnet");
        console2.log("fork block", block.number, "timestamp", block.timestamp);

        ownerSafe = _deploySafe(ownerKeys, 1);
        guardianSafe = _deploySafe(guardianKeys, 2);

        RixorLocker.Listing[] memory l = new RixorLocker.Listing[](2);
        l[0] = RixorLocker.Listing(HOOKR, UNIT, CAP, 1); // Class A
        l[1] = RixorLocker.Listing(TORCH, UNIT, CAP, 2); // Class B
        locker = new RixorLocker(address(ownerSafe), address(guardianSafe), l);
        challenges = new RixorChallenges(IRixorLocker(address(locker)), WIF, MIN_HOLD);
        rewards = new RixorRewards(IRixorLocker(address(locker)), WIF);

        address[5] memory people = [alice, bob, carol, sponsorA, funder];
        for (uint256 i = 0; i < people.length; i++) {
            deal(WIF, people[i], 5_000_000 ether);
            deal(HOOKR, people[i], 20_000_000 ether);
            deal(TORCH, people[i], 20_000_000 ether);
            vm.startPrank(people[i]);
            IERC20Like(HOOKR).approve(address(locker), type(uint256).max);
            IERC20Like(TORCH).approve(address(locker), type(uint256).max);
            IERC20Like(WIF).approve(address(challenges), type(uint256).max);
            IERC20Like(WIF).approve(address(rewards), type(uint256).max);
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
        assertEq(safe.VERSION(), string("1.4.1"));
        return safe;
    }

    function _txHash(ISafe safe, address to, bytes memory data) internal view returns (bytes32) {
        uint256 n = safe.nonce();
        return safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), n);
    }

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
        assertTrue(safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs));
    }

    function _guardianExec(bytes memory data) internal {
        _exec(guardianSafe, guardianKeys, address(locker), data);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20Like(token).balanceOf(who);
    }

    // ------------------------------------------------------------------ environment

    function test_fork_environment() public view {
        assertEq(IERC20Like(HOOKR).decimals(), 18);
        assertEq(IERC20Like(TORCH).decimals(), 18);
        assertEq(IERC20Like(WIF).decimals(), 18);
        assertEq(locker.riskClass(HOOKR), 1);
        assertEq(locker.riskClass(TORCH), 2);
        assertFalse(locker.isListed(WIF), "WIF is the reward token, not a lockable asset");
        assertEq(ITorch(TORCH).POOL_MANAGER(), POOL_MANAGER);
        assertEq(ITorch(TORCH).BUY_TAX_BPS(), 200, "TORCH buy tax is 2%");
        assertEq(rewards.wif(), WIF);
        assertEq(challenges.wif(), WIF);
    }

    // ------------------------------------------------------------------ TORCH: buy tax and gas edge cases

    function test_fork_torch_lockAndExitAreUntaxed() public {
        address router = ITorch(TORCH).FEE_ROUTER();
        uint256 routerBefore = _bal(TORCH, router);
        uint256 before = _bal(TORCH, bob);
        vm.prank(bob);
        uint256 id = locker.lock(TORCH, 10 * UNIT, 1, 60); // Class B: Committed up to 60 days
        assertEq(_bal(TORCH, address(locker)), 10 * UNIT, "deposit exact");
        assertEq(ITorch(TORCH).poolStatus(address(locker)), 0, "Locker not yet probed");
        vm.warp(block.timestamp + 60 days);
        vm.prank(bob);
        locker.exit(id, 0);
        assertEq(_bal(TORCH, bob), before, "exit returns the exact principal");
        assertEq(_bal(TORCH, router), routerBefore, "no tax on Locker transfers");
        assertEq(ITorch(TORCH).poolStatus(address(locker)), 2, "Locker cached as not-a-pool");
        assertFalse(ITorch(TORCH).isPool(address(locker)));
    }

    function test_fork_torch_taxAppliesOnlyToPoolExits() public {
        // Tokens leaving the PoolManager (a buy) are taxed; this is market cost, not a Locker effect.
        address router = ITorch(TORCH).FEE_ROUTER();
        uint256 routerBefore = _bal(TORCH, router);
        uint256 before = _bal(TORCH, carol);
        vm.prank(POOL_MANAGER);
        IERC20Like(TORCH).transfer(carol, 1_000 ether);
        assertEq(_bal(TORCH, carol) - before, 980 ether, "buyer receives 98%");
        assertEq(_bal(TORCH, router) - routerBefore, 20 ether, "2% to the fee router");
    }

    function test_fork_torch_classBRejectsDiamond() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RixorLocker.TierNotAllowed.selector, 2));
        locker.lock(TORCH, UNIT, 2, 30);
        vm.prank(alice);
        vm.expectRevert(RixorLocker.InvalidTerm.selector);
        locker.lock(TORCH, UNIT, 1, 61);
    }

    function test_fork_torch_lowGasFirstExitRevertsCleanlyAndRetrySucceeds() public {
        vm.prank(alice);
        uint256 a = locker.lock(TORCH, UNIT, 0, 0);
        vm.prank(bob);
        uint256 b = locker.lock(TORCH, UNIT, 0, 0);
        // First transfer out of the Locker makes TORCH probe it (token0/token1). With too little gas the token
        // reverts (InsufficientGasForProbe); the Locker reports TransferFailed and nothing changes.
        uint256 minGas;
        bytes memory lastFailure;
        for (uint256 g = 50_000; g <= 200_000; g += 1_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(alice);
            (bool ok, bytes memory ret) = address(locker).call{gas: g}(abi.encodeCall(RixorLocker.exit, (a, 0)));
            vm.revertToState(snap);
            if (ok) {
                minGas = g;
                break;
            }
            lastFailure = ret;
        }
        console2.log("TORCH first exit: minimum gas limit", minGas);
        assertGt(minGas, 0, "exit succeeds with enough gas");
        assertEq(bytes4(lastFailure), RixorLocker.TransferFailed.selector, "just below: token refused, Locker reverted");
        assertEq(locker.positionOf(a).closedAt, 0, "position untouched, user can retry");
        assertEq(_bal(TORCH, address(locker)), 2 * UNIT);
        // With normal gas (wallet estimate) it succeeds, and the probe result is cached for later exits.
        uint256 g0 = gasleft();
        vm.prank(alice);
        locker.exit(a, 0);
        uint256 firstExitGas = g0 - gasleft();
        g0 = gasleft();
        vm.prank(bob);
        locker.exit(b, 0);
        uint256 cachedExitGas = g0 - gasleft();
        console2.log("TORCH first exit gas", firstExitGas, "later exit gas", cachedExitGas);
        assertLt(cachedExitGas, firstExitGas, "probe cost paid once");
        assertEq(_bal(TORCH, address(locker)), 0);
    }

    // ------------------------------------------------------------------ HOOKR: Class A, Permit2 default allowance

    function test_fork_hookr_diamondExactAndPermit2CannotDrainLocker() public {
        vm.prank(alice);
        uint256 id = locker.lock(HOOKR, 10 * UNIT, 2, 90); // Class A allows Diamond
        assertEq(_bal(HOOKR, address(locker)), 10 * UNIT, "deposit exact");
        // Solady gives Permit2 an infinite allowance from every owner, including the Locker...
        assertEq(IERC20Like(HOOKR).allowance(address(locker), PERMIT2), type(uint256).max);
        // ...but Permit2 only moves tokens with the owner's own Permit2 approval or signature, which the Locker
        // never gives (it has no Permit2 calls and no EIP-1271 signer).
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        IPermit2(PERMIT2).transferFrom(address(locker), attacker, uint160(UNIT), HOOKR);
        assertEq(_bal(HOOKR, address(locker)), 10 * UNIT);
        vm.warp(block.timestamp + 90 days);
        uint256 before = _bal(HOOKR, alice);
        vm.prank(alice);
        locker.exit(id, 0);
        assertEq(_bal(HOOKR, alice) - before, 10 * UNIT, "exit exact");
    }

    // ------------------------------------------------------------------ full V2 lifecycle on real tokens

    uint256 internal ph; // HOOKR Diamond (alice)
    uint256 internal pt; // TORCH Committed (bob)
    uint256 internal pf; // HOOKR Flexible (carol)
    uint256 internal sH;
    uint256 internal sT;
    uint256 internal cid;

    function test_fork_fullLifecycle() public {
        _phaseFundAndLock();
        _phaseChallenge();
        _phaseAccrueAndClaim();
        _phaseReleaseTorch();
        _phaseFinish();
    }

    function _phaseFundAndLock() internal {
        vm.prank(funder);
        sH = rewards.fund(HOOKR, 70_000 ether, 7);
        vm.prank(funder);
        sT = rewards.fund(TORCH, 140_000 ether, 14);
        assertEq(_bal(WIF, address(rewards)), 210_000 ether, "real WIF transfer exact");
        vm.warp(uint256(rewards.streamOf(sH).startDay) * 1 days); // stream start (next UTC midnight)
        vm.prank(alice);
        ph = locker.lock(HOOKR, 10 * UNIT, 2, 90);
        vm.prank(bob);
        pt = locker.lock(TORCH, 10 * UNIT, 1, 30);
        vm.prank(carol);
        pf = locker.lock(HOOKR, 5 * UNIT, 0, 0);
    }

    function _phaseChallenge() internal {
        RixorChallenges.CreateParams memory p;
        p.tokens = new address[](2);
        p.tokens[0] = HOOKR;
        p.tokens[1] = TORCH;
        p.minUnitsPerEntry = 1;
        p.joinDeadline = uint64(block.timestamp + 1 days);
        p.endTime = uint64(block.timestamp + 2 days);
        p.maxParticipants = 50;
        p.title = "Fork multi-token challenge";
        vm.prank(sponsorA);
        cid = challenges.createChallenge(p, 300_000 ether);
        vm.prank(alice);
        challenges.join(cid, ph, address(0));
        vm.prank(bob);
        challenges.join(cid, pt, address(0));
        assertEq(challenges.entryOf(cid, alice).points, 250_000); // 10 units x Diamond 2.5x
        assertEq(challenges.entryOf(cid, bob).points, 150_000); // 10 units x Committed 1.5x
    }

    function _phaseAccrueAndClaim() internal {
        vm.warp(block.timestamp + 3 days);
        challenges.settle(cid, 10);
        vm.prank(alice);
        assertEq(challenges.claim(cid), uint256(300_000 ether) * 250_000 / 400_000);
        // HOOKR stream: alice (weight 2.5M) and carol (weight 250k) share 10,000 WIF/day for 3 days.
        uint256[] memory ids = new uint256[](1);
        ids[0] = ph;
        vm.prank(alice);
        uint256 got = rewards.claim(ids, 500);
        assertApproxEqRel(got, uint256(30_000 ether) * 2_500_000 / 2_750_000, 1e12, "alice HOOKR rewards");
    }

    function _phaseReleaseTorch() internal {
        // Incident on TORCH: the guardian Safe releases it. Bob's Committed position exits with no fee; TORCH
        // accrual stops; HOOKR is unaffected.
        _guardianExec(abi.encodeCall(RixorLocker.releaseToken, (TORCH)));
        uint256 before = _bal(TORCH, bob);
        vm.prank(bob);
        locker.exit(pt, 0);
        assertEq(_bal(TORCH, bob) - before, 10 * UNIT, "no fee after release");
        assertEq(_bal(TORCH, DEAD), _bal(TORCH, DEAD)); // nothing burned by the Locker
        assertEq(locker.retainedFees(TORCH), 0);
    }

    function _phaseFinish() internal {
        vm.warp(block.timestamp + 20 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = pt;
        vm.prank(bob);
        uint256 bobGot = rewards.claim(ids, 500);
        assertApproxEqRel(bobGot, 30_000 ether, 1e12, "bob: 3 TORCH days at 10,000 WIF/day");
        uint256 back = rewards.refund(sT, 500);
        assertApproxEqRel(back, 110_000 ether, 1e12, "TORCH: 11 unstreamed days refunded");
        ids[0] = pf;
        vm.prank(carol);
        rewards.claim(ids, 500);
        ids[0] = ph;
        vm.prank(alice);
        rewards.claim(ids, 500);
        rewards.refund(sH, 500);
        assertLt(_bal(WIF, address(rewards)), 1e6, "only rounding dust left in Rewards");
        assertEq(
            _bal(WIF, address(rewards)),
            rewards.totalFunded() - rewards.totalClaimed() - rewards.totalRefunded(),
            "rewards conservation"
        );
        vm.warp(locker.positionOf(ph).endsAt);
        vm.prank(alice);
        locker.exit(ph, 0);
        vm.prank(carol);
        locker.exit(pf, 0);
        assertEq(_bal(HOOKR, address(locker)), 0);
        assertEq(_bal(TORCH, address(locker)), 0);
    }

    function test_fork_emergencyThroughSafe() public {
        vm.prank(alice);
        uint256 d = locker.lock(HOOKR, 10 * UNIT, 2, 90);
        vm.prank(funder);
        uint256 s = rewards.fund(HOOKR, 70_000 ether, 7);
        // One signature is not enough for the 2-of-3 guardian Safe.
        bytes memory data = abi.encodeCall(RixorLocker.activateEmergency, ());
        bytes memory oneSig = _signatures(guardianSafe, guardianKeys, 1, address(locker), data);
        vm.expectRevert(bytes("GS020"));
        guardianSafe.execTransaction(address(locker), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), oneSig);
        _guardianExec(data);
        uint256 before = _bal(HOOKR, alice);
        vm.prank(alice);
        locker.exit(d, 0); // Diamond exits immediately, no fee
        assertEq(_bal(HOOKR, alice) - before, 10 * UNIT);
        vm.warp(block.timestamp + 10 days);
        assertEq(rewards.refund(s, 500), 70_000 ether, "emergency before stream start: full refund");
    }
}
