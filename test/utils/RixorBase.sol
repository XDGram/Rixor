// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RixorLocker} from "../../contracts/RixorLocker.sol";
import {RixorChallenges} from "../../contracts/RixorChallenges.sol";
import {IRixorLocker} from "../../contracts/interfaces/IRixorLocker.sol";
import {MockERC20, MockSafe} from "./Mocks.sol";

/// @dev Shared setup for unit tests: mock tokens, Safe-like owner/guardian contracts, Locker and Challenges.
abstract contract RixorBase is Test {
    RixorLocker internal locker;
    RixorChallenges internal challenges;
    MockERC20 internal wif;
    MockERC20 internal dope;
    MockERC20 internal meme3;
    /// @dev Second listed meme token (Class A). Takes the lock-side role $WIF had in Gate 1 fixtures.
    MockERC20 internal pepe;
    MockSafe internal ownerSafe;
    MockSafe internal guardianSafe;

    address internal admin = makeAddr("admin-operator");
    address internal guardianOperator = makeAddr("guardian-operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dan = makeAddr("dan");
    address internal sponsorA = makeAddr("sponsorA");
    address internal sponsorB = makeAddr("sponsorB");

    uint256 internal constant PEPE_UNIT = 7_000 ether;
    uint256 internal constant PEPE_CAP = 3_500_000 ether;
    uint256 internal constant DOPE_UNIT = 1_000 ether;
    uint256 internal constant DOPE_CAP = 500_000 ether;
    uint256 internal constant MIN_HOLD = 24 hours;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        wif = new MockERC20("Test Reward Token (WIF stand-in)", "tWIF", 18);
        dope = new MockERC20("Test Meme A", "tMEMEA", 18);
        meme3 = new MockERC20("Test Meme B", "tMEMEB", 18);
        pepe = new MockERC20("Test Meme C", "tMEMEC", 18);
        ownerSafe = new MockSafe(admin);
        guardianSafe = new MockSafe(guardianOperator);

        // $WIF is the reward and prize token only; it is not listed in the Locker.
        RixorLocker.Listing[] memory initial = new RixorLocker.Listing[](2);
        initial[0] = RixorLocker.Listing(address(pepe), PEPE_UNIT, PEPE_CAP, 1);
        initial[1] = RixorLocker.Listing(address(dope), DOPE_UNIT, DOPE_CAP, 1);

        locker = new RixorLocker(address(ownerSafe), address(guardianSafe), initial);
        challenges = new RixorChallenges(IRixorLocker(address(locker)), address(wif), MIN_HOLD);

        address[8] memory people = [alice, bob, carol, dan, sponsorA, sponsorB, address(ownerSafe), makeAddr("spare")];
        for (uint256 i = 0; i < people.length; i++) {
            wif.mint(people[i], 50_000_000 ether);
            dope.mint(people[i], 50_000_000 ether);
            meme3.mint(people[i], 50_000_000 ether);
            pepe.mint(people[i], 50_000_000 ether);
            vm.startPrank(people[i]);
            wif.approve(address(locker), type(uint256).max);
            dope.approve(address(locker), type(uint256).max);
            meme3.approve(address(locker), type(uint256).max);
            pepe.approve(address(locker), type(uint256).max);
            wif.approve(address(challenges), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(admin);
        ownerSafe.exec(
            address(wif), abi.encodeWithSignature("approve(address,uint256)", address(challenges), type(uint256).max)
        );
    }

    // ------------------------------------------------------------------ helpers

    function asOwner(bytes memory data) internal returns (bytes memory) {
        vm.prank(admin);
        return ownerSafe.exec(address(locker), data);
    }

    function asGuardian(bytes memory data) internal returns (bytes memory) {
        vm.prank(guardianOperator);
        return guardianSafe.exec(address(locker), data);
    }

    function lockAs(address who, address token, uint256 amount, uint8 tier, uint256 termDays)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = locker.lock(token, amount, tier, termDays);
    }

    function params(address[] memory tokens, uint64 joinIn, uint64 endIn)
        internal
        view
        returns (RixorChallenges.CreateParams memory p)
    {
        p.tokens = tokens;
        p.minTier = 0;
        p.minUnitsPerEntry = 1;
        p.joinDeadline = uint64(block.timestamp) + joinIn;
        p.endTime = uint64(block.timestamp) + endIn;
        p.goalPoints = 0;
        p.maxParticipants = 200;
        p.title = "Hold the line";
        p.description = "Test challenge";
    }

    function dopePepe() internal view returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = address(dope);
        tokens[1] = address(pepe);
    }

    function only(address token) internal pure returns (address[] memory tokens) {
        tokens = new address[](1);
        tokens[0] = token;
    }

    /// @dev Standard community challenge: join window 1 day, ends 1 day + MIN_HOLD later.
    function createDefault(address sponsor_, uint256 pool) internal returns (uint256 id) {
        RixorChallenges.CreateParams memory p = params(dopePepe(), 1 days, 1 days + uint64(MIN_HOLD));
        vm.prank(sponsor_);
        id = challenges.createChallenge(p, pool);
    }

    function createWith(address sponsor_, RixorChallenges.CreateParams memory p, uint256 pool)
        internal
        returns (uint256 id)
    {
        vm.prank(sponsor_);
        id = challenges.createChallenge(p, pool);
    }

    function joinAs(address who, uint256 id, uint256 positionId) internal {
        vm.prank(who);
        challenges.join(id, positionId, address(0));
    }

    function endTimeOf(uint256 id) internal view returns (uint64) {
        return challenges.getChallenge(id).endTime;
    }

    function settleAll(uint256 id) internal {
        challenges.settle(id, 1_000);
    }
}
