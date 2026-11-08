// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {console2} from "forge-std/console2.sol";
import {RixorBase} from "../utils/RixorBase.sol";
import {RixorLocker} from "../../contracts/RixorLocker.sol";
import {RixorChallenges} from "../../contracts/RixorChallenges.sol";
import {RixorRewards} from "../../contracts/RixorRewards.sol";
import {IRixorLocker} from "../../contracts/interfaces/IRixorLocker.sol";
import {MockERC20, MockSafe} from "../utils/Mocks.sol";

/// @dev Drives random sequences of every user-facing action and keeps ghost accounting that the
///      invariants compare against contract state.
contract RixorHandler is Test {
    RixorLocker internal locker;
    RixorChallenges internal challenges;
    RixorRewards internal rewards;
    MockERC20 internal wif;
    MockERC20 internal dope;
    MockERC20 internal pepe;
    MockSafe internal ownerSafe;
    MockSafe internal guardianSafe;
    address internal admin;
    address internal guardianOperator;

    address[4] internal actors;
    address[3] internal sponsors; // index 2 is the owner Safe (Season creator)

    uint256[] public positions;
    uint256[] public challengeIds;
    uint256[] public streamIds;

    struct LaneRecord {
        uint256 positionId;
        bool season;
        uint256 challengeId;
        uint64 joinedAt;
    }

    LaneRecord[] public laneRecords;

    mapping(uint256 positionId => uint64) public ghostClosedAt;
    mapping(uint256 id => uint256) public ghostClaimed;
    mapping(uint256 id => uint256) public ghostOutflow;
    mapping(uint256 id => mapping(address sponsor => uint256)) public ghostSponsorReceipts;

    bool public eligibleCallReverted;
    bool public ineligibleCallSucceeded;
    bool public closedAtRewritten;
    bool public crossChallengeOutflow;
    bool public emergencyOn;
    bool public releasedOn;
    bool public allowedExitReverted;
    bool public syncReverted;
    bool public rewardPayoutMismatch;

    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public successes;

    constructor(
        RixorLocker locker_,
        RixorChallenges challenges_,
        RixorRewards rewards_,
        MockERC20 wif_,
        MockERC20 dope_,
        MockERC20 pepe_
    ) {
        locker = locker_;
        challenges = challenges_;
        rewards = rewards_;
        wif = wif_;
        dope = dope_;
        pepe = pepe_;
    }

    function init(
        MockSafe ownerSafe_,
        MockSafe guardianSafe_,
        address admin_,
        address guardianOperator_,
        address[4] calldata actors_,
        address[2] calldata sponsors_
    ) external {
        require(address(ownerSafe) == address(0), "init once");
        ownerSafe = ownerSafe_;
        guardianSafe = guardianSafe_;
        admin = admin_;
        guardianOperator = guardianOperator_;
        actors = actors_;
        sponsors = [sponsors_[0], sponsors_[1], address(ownerSafe_)];
    }

    // ------------------------------------------------------------------ helpers

    function positionCount() external view returns (uint256) {
        return positions.length;
    }

    function streamCount() external view returns (uint256) {
        return streamIds.length;
    }

    function challengeCount() external view returns (uint256) {
        return challengeIds.length;
    }

    function laneRecordCount() external view returns (uint256) {
        return laneRecords.length;
    }

    function laneRecordAt(uint256 i) external view returns (LaneRecord memory) {
        return laneRecords[i];
    }

    function sponsorAt(uint256 i) external view returns (address) {
        return sponsors[i];
    }

    function _pickChallenge(uint256 seed) internal view returns (uint256) {
        if (challengeIds.length == 0) return 0;
        return challengeIds[seed % challengeIds.length];
    }

    /// @dev Phase filter used to steer actions toward challenges where they can do something.
    ///      0 = joinable, 1 = ended and unsettled, 2 = settled. Falls back to a random pick.
    function _pickInPhase(uint256 seed, uint8 phase) internal view returns (uint256) {
        uint256 n = challengeIds.length;
        if (n == 0) return 0;
        for (uint256 k = 0; k < n; k++) {
            uint256 id = challengeIds[(seed % n + k) % n];
            RixorChallenges.Challenge memory c = challenges.getChallenge(id);
            if (phase == 0 && block.timestamp <= c.joinDeadline) return id;
            if (phase == 1 && block.timestamp > c.endTime && !c.settled) return id;
            if (phase == 2 && c.settled) return id;
        }
        // Nothing open to join: a join would only hit JoinClosed (covered by unit tests).
        if (phase == 0) return 0;
        return challengeIds[seed % n];
    }

    function _syncClosedAt(uint256 positionId) internal {
        uint64 closedAt = locker.positionOf(positionId).closedAt;
        uint64 ghost = ghostClosedAt[positionId];
        if (ghost != 0 && closedAt != ghost) closedAtRewritten = true;
        if (ghost == 0 && closedAt != 0) ghostClosedAt[positionId] = closedAt;
    }

    // ------------------------------------------------------------------ actions

    function lock(uint256 actorSeed, bool usePepe, uint256 amountSeed, uint256 tierSeed, uint256 termSeed) external {
        calls["lock"]++;
        address who = actors[actorSeed % 4];
        address token = usePepe ? address(pepe) : address(dope);
        uint256 unit = locker.unitAmount(token);
        uint256 amount = bound(amountSeed, unit, 12 * unit);
        uint8 tier = uint8(tierSeed % 3);
        uint256 term = tier == 0 ? 0 : bound(termSeed, 30, 90);
        vm.prank(who);
        try locker.lock(token, amount, tier, term) returns (uint256 id) {
            positions.push(id);
            successes["lock"]++;
        } catch {}
    }

    function exit(uint256 positionSeed) external {
        calls["exit"]++;
        if (positions.length == 0) return;
        uint256 id = positions[positionSeed % positions.length];
        IRixorLocker.PositionView memory p = locker.positionOf(id);
        (bool allowed,) = locker.exitTerms(id);
        vm.prank(p.owner);
        try locker.exit(id, 10_000) {
            successes["exit"]++;
        } catch {
            // An exit the Locker reports as allowed must always succeed, whatever Rewards or Challenges hold.
            if (allowed) allowedExitReverted = true;
        }
        _syncClosedAt(id);
    }

    function create(uint256 sponsorSeed, uint256 poolSeed, uint256 joinSeed, uint256 holdSeed, uint256 goalSeed)
        external
    {
        calls["create"]++;
        uint256 si = sponsorSeed % 3;
        RixorChallenges.CreateParams memory p;
        if (si == 2) {
            p.tokens = new address[](2);
            p.tokens[0] = address(pepe);
            p.tokens[1] = address(dope);
        } else if (sponsorSeed % 2 == 0) {
            p.tokens = new address[](2);
            p.tokens[0] = address(dope);
            p.tokens[1] = address(pepe);
        } else {
            p.tokens = new address[](1);
            p.tokens[0] = address(dope);
        }
        p.minTier = uint8(goalSeed % 3 == 0 ? 1 : 0);
        p.minUnitsPerEntry = uint8(1 + (goalSeed % 3));
        p.joinDeadline = uint64(block.timestamp + bound(joinSeed, 6 hours, 5 days));
        p.endTime = p.joinDeadline + uint64(challenges.minHold()) + uint64(bound(holdSeed, 0, 3 days));
        p.goalPoints = goalSeed % 4 == 0 ? bound(goalSeed, 0, 400_000) : 0;
        p.maxParticipants = uint16(bound(goalSeed, 1, 6));
        p.title = "Invariant challenge";
        uint256 pool = bound(poolSeed, 100_000 ether, 1_000_000 ether);

        uint256 id;
        bool ok;
        if (si == 2) {
            vm.prank(admin);
            try ownerSafe.exec(address(challenges), abi.encodeCall(RixorChallenges.createSeason, (p, pool))) returns (
                bytes memory out
            ) {
                id = abi.decode(out, (uint256));
                ok = true;
            } catch {}
        } else {
            vm.prank(sponsors[si]);
            try challenges.createChallenge(p, pool) returns (uint256 newId) {
                id = newId;
                ok = true;
            } catch {}
        }
        if (ok) {
            challengeIds.push(id);
            successes["create"]++;
        }
    }

    function sponsor(uint256 sponsorSeed, uint256 challengeSeed, uint256 amountSeed) external {
        calls["sponsor"]++;
        uint256 id = _pickChallenge(challengeSeed);
        if (id == 0) return;
        address who = sponsors[sponsorSeed % 2];
        uint256 amount = bound(amountSeed, 10_000 ether, 300_000 ether);
        vm.prank(who);
        try challenges.sponsor(id, amount) {
            successes["sponsor"]++;
        } catch {}
    }

    function join(uint256 actorSeed, uint256 challengeSeed, uint256 positionSeed) external {
        calls["join"]++;
        uint256 id = _pickInPhase(challengeSeed, 0);
        if (id == 0 || positions.length == 0) return;
        uint256 pid = positions[positionSeed % positions.length];
        // Prefer a position that can actually score in this challenge; lanes, ownership and
        // timing are still left to the contract to enforce.
        for (uint256 k = 0; k < positions.length; k++) {
            uint256 cand = positions[(positionSeed % positions.length + k) % positions.length];
            if (challenges.previewPoints(id, cand) > 0) {
                pid = cand;
                break;
            }
        }
        // Mostly the position's owner; occasionally a random actor (exercises NotPositionOwner).
        address who = actorSeed % 8 == 0 ? actors[(actorSeed >> 3) % 4] : locker.positionOf(pid).owner;
        vm.prank(who);
        try challenges.join(id, pid, address(0)) {
            successes["join"]++;
            laneRecords.push(LaneRecord(pid, challenges.getChallenge(id).isSeason, id, uint64(block.timestamp)));
        } catch {}
    }

    function warp(uint256 secondsSeed) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(secondsSeed, 1 minutes, 1 days));
    }

    /// @dev Occasional long jump so claim windows close and sweeps become reachable.
    function warpLong(uint256 secondsSeed) external {
        calls["warpLong"]++;
        if (uint256(keccak256(abi.encode(secondsSeed, block.timestamp))) % 4 != 0) return;
        vm.warp(block.timestamp + bound(secondsSeed, 10 days, 35 days));
    }

    function settle(uint256 challengeSeed, uint256 maxItems) external {
        calls["settle"]++;
        uint256 id = _pickInPhase(challengeSeed, 1);
        if (id == 0) return;
        try challenges.settle(id, bound(maxItems, 1, 6)) {
            successes["settle"]++;
        } catch {}
    }

    function claim(uint256 actorSeed, uint256 challengeSeed) external {
        calls["claim"]++;
        uint256 id = _pickInPhase(challengeSeed, 2);
        if (id == 0) return;
        address who = actors[actorSeed % 4];
        for (uint256 k = 0; k < 4; k++) {
            address cand = actors[(actorSeed % 4 + k) % 4];
            RixorChallenges.Entry memory ce = challenges.entryOf(id, cand);
            if (ce.qualified && !ce.claimed) {
                who = cand;
                break;
            }
        }
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        RixorChallenges.Entry memory e = challenges.entryOf(id, who);
        bool eligible = c.settled && c.success && e.qualified && !e.claimed && block.timestamp <= c.claimDeadline;
        uint256 balBefore = wif.balanceOf(address(challenges));
        uint256 escrowBefore = c.escrow;
        vm.prank(who);
        try challenges.claim(id) returns (uint256 amount) {
            if (!eligible) ineligibleCallSucceeded = true;
            ghostClaimed[id] += amount;
            successes["claim"]++;
            _recordOutflow(id, balBefore, escrowBefore);
        } catch {
            if (eligible) eligibleCallReverted = true;
        }
    }

    function refund(uint256 sponsorSeed, uint256 challengeSeed) external {
        calls["refund"]++;
        uint256 id = challengeSeed % 2 == 0 ? _pickInPhase(challengeSeed, 2) : _pickChallenge(challengeSeed);
        if (id == 0) return;
        address who = sponsors[sponsorSeed % 3];
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        bool cancelled = challenges.isCancelled(id);
        bool eligible = (cancelled || (c.settled && !c.success)) && challenges.contributionOf(id, who) > 0
            && !challenges.refunded(id, who);
        uint256 balBefore = wif.balanceOf(address(challenges));
        uint256 escrowBefore = c.escrow;
        vm.prank(who);
        try challenges.refund(id) returns (uint256 amount) {
            successes["refund"]++;
            if (!eligible) ineligibleCallSucceeded = true;
            ghostSponsorReceipts[id][who] += amount;
            _recordOutflow(id, balBefore, escrowBefore);
        } catch {
            if (eligible) eligibleCallReverted = true;
        }
    }

    function sweep(uint256 sponsorSeed, uint256 challengeSeed) external {
        calls["sweep"]++;
        uint256 id = _pickInPhase(challengeSeed, 2);
        if (id == 0) return;
        address who = sponsors[sponsorSeed % 3];
        RixorChallenges.Challenge memory c = challenges.getChallenge(id);
        bool eligible = c.settled && c.success && block.timestamp > c.claimDeadline
            && challenges.contributionOf(id, who) > 0 && !challenges.swept(id, who);
        uint256 balBefore = wif.balanceOf(address(challenges));
        uint256 escrowBefore = c.escrow;
        vm.prank(who);
        try challenges.sweep(id) returns (uint256 amount) {
            successes["sweep"]++;
            if (!eligible) ineligibleCallSucceeded = true;
            ghostSponsorReceipts[id][who] += amount;
            _recordOutflow(id, balBefore, escrowBefore);
        } catch {
            if (eligible) eligibleCallReverted = true;
        }
    }

    /// @dev Rare: about one call in 60 actually activates the emergency (hashed so that the fuzzer's
    ///      favourite seeds such as 0 do not trigger it at the start of every run).
    function emergency(uint256 seed) external {
        calls["emergency"]++;
        if (emergencyOn || uint256(keccak256(abi.encode(seed, block.timestamp))) % 60 != 0) return;
        vm.prank(guardianOperator);
        guardianSafe.exec(address(locker), abi.encodeCall(RixorLocker.activateEmergency, ()));
        emergencyOn = true;
        successes["emergency"]++;
    }

    // ------------------------------------------------------------------ rewards actions

    function fundStream(uint256 sponsorSeed, bool usePepe, uint256 amountSeed, uint256 daysSeed) external {
        calls["fund"]++;
        address who = sponsors[sponsorSeed % 2];
        address token = usePepe ? address(pepe) : address(dope);
        vm.prank(who);
        try rewards.fund(token, bound(amountSeed, 10_000 ether, 500_000 ether), bound(daysSeed, 7, 90)) returns (
            uint256 sid
        ) {
            streamIds.push(sid);
            successes["fund"]++;
        } catch {}
    }

    function claimRewards(uint256 positionSeed) external {
        calls["claimRewards"]++;
        if (positions.length == 0) return;
        uint256 id = positions[positionSeed % positions.length];
        IRixorLocker.PositionView memory p = locker.positionOf(id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 before = wif.balanceOf(p.owner);
        vm.prank(p.owner);
        try rewards.claim(ids, 400) returns (uint256 paid) {
            successes["claimRewards"]++;
            if (wif.balanceOf(p.owner) - before != paid) rewardPayoutMismatch = true;
        } catch {}
    }

    function refundStream(uint256 streamSeed) external {
        calls["refundStream"]++;
        if (streamIds.length == 0) return;
        try rewards.refund(streamIds[streamSeed % streamIds.length], 400) {
            successes["refundStream"]++;
        } catch {}
    }

    function syncRewards(bool usePepe, uint256 stepsSeed) external {
        calls["sync"]++;
        try rewards.sync(usePepe ? address(pepe) : address(dope), bound(stepsSeed, 1, 50)) {
            successes["sync"]++;
        } catch {
            syncReverted = true; // sync must never revert for a listed token
        }
    }

    /// @dev Rare per-token release of DOPE (hashed, like emergency).
    function release(uint256 seed) external {
        calls["release"]++;
        if (releasedOn || uint256(keccak256(abi.encode(seed, block.timestamp, "r"))) % 80 != 0) return;
        vm.prank(guardianOperator);
        guardianSafe.exec(address(locker), abi.encodeCall(RixorLocker.releaseToken, (address(dope))));
        releasedOn = true;
        successes["release"]++;
    }

    /// @dev Every WIF that leaves the Challenges contract during a payout must come out of that
    ///      challenge's own escrow, and no other challenge's escrow may change.
    function _recordOutflow(uint256 id, uint256 balBefore, uint256 escrowBefore) internal {
        uint256 out = balBefore - wif.balanceOf(address(challenges));
        ghostOutflow[id] += out;
        if (escrowBefore - challenges.getChallenge(id).escrow != out) crossChallengeOutflow = true;
    }

    function syncAllClosedAt() external {
        for (uint256 i = 0; i < positions.length; i++) {
            _syncClosedAt(positions[i]);
        }
    }
}

contract RixorInvariantsTest is StdInvariant, RixorBase {
    RixorHandler internal handler;
    RixorRewards internal rewards;

    function setUp() public override {
        super.setUp();
        rewards = new RixorRewards(IRixorLocker(address(locker)), address(wif));
        vm.prank(sponsorA);
        wif.approve(address(rewards), type(uint256).max);
        vm.prank(sponsorB);
        wif.approve(address(rewards), type(uint256).max);
        handler = new RixorHandler(locker, challenges, rewards, wif, dope, pepe);
        handler.init(ownerSafe, guardianSafe, admin, guardianOperator, [alice, bob, carol, dan], [sponsorA, sponsorB]);
        // Weighted selector table: deep-state actions appear more than once.
        bytes4[] memory selectors = new bytes4[](27);
        selectors[0] = RixorHandler.lock.selector;
        selectors[1] = RixorHandler.lock.selector;
        selectors[2] = RixorHandler.lock.selector;
        selectors[3] = RixorHandler.exit.selector;
        selectors[4] = RixorHandler.create.selector;
        selectors[5] = RixorHandler.create.selector;
        selectors[6] = RixorHandler.sponsor.selector;
        selectors[7] = RixorHandler.join.selector;
        selectors[8] = RixorHandler.join.selector;
        selectors[9] = RixorHandler.join.selector;
        selectors[10] = RixorHandler.join.selector;
        selectors[11] = RixorHandler.warp.selector;
        selectors[12] = RixorHandler.settle.selector;
        selectors[13] = RixorHandler.settle.selector;
        selectors[14] = RixorHandler.claim.selector;
        selectors[15] = RixorHandler.claim.selector;
        selectors[16] = RixorHandler.refund.selector;
        selectors[17] = RixorHandler.sweep.selector;
        selectors[18] = RixorHandler.emergency.selector;
        selectors[19] = RixorHandler.warpLong.selector;
        selectors[20] = RixorHandler.fundStream.selector;
        selectors[21] = RixorHandler.fundStream.selector;
        selectors[22] = RixorHandler.claimRewards.selector;
        selectors[23] = RixorHandler.claimRewards.selector;
        selectors[24] = RixorHandler.refundStream.selector;
        selectors[25] = RixorHandler.syncRewards.selector;
        selectors[26] = RixorHandler.release.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Total escrow always covers all outstanding challenge liabilities.
    function invariant_escrowCoversLiabilities() public view {
        uint256 sum;
        uint256 n = handler.challengeCount();
        for (uint256 i = 0; i < n; i++) {
            sum += challenges.getChallenge(handler.challengeIds(i)).escrow;
        }
        assertEq(challenges.totalEscrow(), sum, "totalEscrow == sum of escrows");
        assertGe(wif.balanceOf(address(challenges)), challenges.totalEscrow(), "WIF balance covers escrow");
    }

    /// Total claims never exceed the funded pool; per-challenge conservation holds.
    function invariant_claimsBoundedAndConserved() public view {
        uint256 n = handler.challengeCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.challengeIds(i);
            RixorChallenges.Challenge memory c = challenges.getChallenge(id);
            assertLe(c.claimedTotal, c.pool, "claims <= pool");
            assertEq(c.claimedTotal, handler.ghostClaimed(id), "claim ghost");
            assertEq(c.claimedTotal + c.refundedTotal + c.sweptTotal + c.escrow, c.pool, "conservation");
            assertEq(handler.ghostOutflow(id), c.claimedTotal + c.refundedTotal + c.sweptTotal, "outflow ghost");
            // A challenge never pays both claims and refunds.
            assertTrue(c.claimedTotal == 0 || c.refundedTotal == 0, "claims and refunds exclusive");
        }
    }

    /// One challenge cannot use another challenge's escrow.
    function invariant_noCrossChallengeOutflow() public view {
        assertFalse(handler.crossChallengeOutflow(), "payout drew from another challenge's escrow");
    }

    /// A sponsor cannot receive more than their refundable contribution.
    function invariant_sponsorReceiptsBounded() public view {
        uint256 n = handler.challengeCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.challengeIds(i);
            for (uint256 s = 0; s < 3; s++) {
                address who = handler.sponsorAt(s);
                assertLe(
                    handler.ghostSponsorReceipts(id, who), challenges.contributionOf(id, who), "sponsor over-receipt"
                );
            }
        }
    }

    /// A position cannot occupy two community lanes or two Season lanes simultaneously.
    function invariant_laneExclusivity() public view {
        uint256 n = handler.laneRecordCount();
        for (uint256 i = 0; i < n; i++) {
            RixorHandler.LaneRecord memory a = handler.laneRecordAt(i);
            for (uint256 j = i + 1; j < n; j++) {
                RixorHandler.LaneRecord memory b = handler.laneRecordAt(j);
                if (a.positionId != b.positionId || a.season != b.season) continue;
                // Record b was joined later; the earlier challenge must already have ended.
                assertLe(challenges.getChallenge(a.challengeId).endTime, b.joinedAt, "overlapping lane occupancy");
                assertTrue(a.challengeId != b.challengeId, "joined the same challenge twice");
            }
        }
    }

    /// closedAt can only be written once.
    function invariant_closedAtWriteOnce() public {
        handler.syncAllClosedAt();
        assertFalse(handler.closedAtRewritten(), "closedAt rewritten");
    }

    /// Emergency activation cannot interfere with already-settled claims, refunds or sweeps,
    /// and ineligible payouts never succeed.
    function invariant_payoutEligibilityRespected() public view {
        assertFalse(handler.eligibleCallReverted(), "an eligible claim/refund/sweep reverted");
        assertFalse(handler.ineligibleCallSucceeded(), "an ineligible payout succeeded");
    }

    /// The Locker always holds every open position's principal.
    function invariant_lockerSolvent() public view {
        address[2] memory toks = [address(pepe), address(dope)];
        for (uint256 t = 0; t < 2; t++) {
            RixorLocker.TokenConfig memory cfg = locker.tokenConfig(toks[t]);
            assertGe(MockERC20(toks[t]).balanceOf(address(locker)), cfg.totalLocked, "locker solvency");
            assertLe(cfg.totalLocked, cfg.maxTotalLocked, "cap respected");
        }
        uint256 openSum;
        uint256 n = handler.positionCount();
        for (uint256 i = 0; i < n; i++) {
            IRixorLocker.PositionView memory p = locker.positionOf(handler.positions(i));
            if (p.closedAt == 0 && p.token == address(dope)) openSum += p.amount;
        }
        assertEq(openSum, locker.tokenConfig(address(dope)).totalLocked, "open DOPE positions == totalLocked");
        assertEq(locker.tokenConfig(address(wif)).totalLocked, 0, "the reward token is never lockable");
    }

    /// Per token: the latest checkpoint, totalWeight and the sum of open position weights agree.
    function invariant_checkpointsMatchOpenWeight() public view {
        address[2] memory toks = [address(pepe), address(dope)];
        uint256 n = handler.positionCount();
        for (uint256 t = 0; t < 2; t++) {
            uint256 open;
            for (uint256 i = 0; i < n; i++) {
                IRixorLocker.PositionView memory p = locker.positionOf(handler.positions(i));
                if (p.closedAt == 0 && p.token == toks[t]) open += p.weight;
            }
            (, uint256 last) = locker.checkpointAt(toks[t], locker.checkpointCount(toks[t]) - 1);
            assertEq(last, open, "latest checkpoint == open weight");
            assertEq(locker.tokenConfig(toks[t]).totalWeight, open, "totalWeight == open weight");
        }
    }

    /// Exits that the Locker allows never revert (independent of Rewards and Challenges).
    function invariant_allowedExitsNeverRevert() public view {
        assertFalse(handler.allowedExitReverted(), "an allowed exit reverted");
    }

    /// Rewards: the WIF balance equals funded - claimed - refunded, and covers everything currently payable.
    function invariant_rewardsSolventAndConserved() public view {
        uint256 bal = wif.balanceOf(address(rewards));
        assertEq(bal, rewards.totalFunded() - rewards.totalClaimed() - rewards.totalRefunded(), "rewards balance");
        uint256 payable_;
        uint256 n = handler.positionCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.positions(i);
            (uint256 total, bool ready) = rewards.earned(id);
            if (ready) {
                assertGe(total, rewards.claimedOf(id), "earned never decreases below claimed");
                payable_ += total - rewards.claimedOf(id);
            }
        }
        uint256 m = handler.streamCount();
        for (uint256 i = 0; i < m; i++) {
            uint256 sid = handler.streamIds(i);
            if (rewards.streamOf(sid).refunded) continue;
            (uint256 amount, bool ready) = rewards.refundable(sid);
            if (ready) payable_ += amount;
        }
        assertLe(payable_, bal, "payable obligations covered");
        assertFalse(handler.syncReverted(), "sync reverted");
        assertFalse(handler.rewardPayoutMismatch(), "claim paid a different amount than reported");
    }

    /// @dev Totals of successful handler actions, logged once per run (visible with -vv) to show the
    ///      fuzzer reaches deep states rather than reverting harmlessly.
    function afterInvariant() external view {
        bytes32[15] memory k = [
            bytes32("lock"),
            "exit",
            "create",
            "sponsor",
            "join",
            "settle",
            "claim",
            "refund",
            "sweep",
            "emergency",
            "fund",
            "claimRewards",
            "refundStream",
            "sync",
            "release"
        ];
        string memory line = "successes:";
        for (uint256 i = 0; i < k.length; i++) {
            line = string.concat(line, " ", _str(k[i]), "=", vm.toString(handler.successes(k[i])));
        }
        console2.log(line);
    }

    function _str(bytes32 b) internal pure returns (string memory) {
        uint256 n;
        while (n < 32 && b[n] != 0) n++;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
        return string(out);
    }
}
