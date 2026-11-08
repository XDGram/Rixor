// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRixorLocker
/// @notice Read-only surface of RixorLocker used by RixorChallenges and RixorRewards. Nothing in this interface
///         can move tokens or change Locker state.
interface IRixorLocker {
    struct PositionView {
        address owner;
        address token;
        uint8 tier;
        uint64 startedAt;
        uint64 endsAt;
        uint64 closedAt;
        uint256 amount;
        /// @dev amount x tier multiplier / 10_000, fixed at lock.
        uint256 weight;
        /// @dev Index into the token's checkpoints written by the lock.
        uint32 startCheckpoint;
        /// @dev Index written by the exit; meaningful only once closedAt != 0.
        uint32 endCheckpoint;
    }

    /// @notice Administrative owner (a Safe). Also the only account allowed to create Season challenges.
    function owner() external view returns (address);

    /// @notice True while new activity (locks, challenge creation, joins, sponsorship) is paused.
    function paused() external view returns (bool);

    /// @notice Timestamp at which emergency mode was activated, or 0 if never.
    function emergencyActivatedAt() external view returns (uint64);

    /// @notice Timestamp at which `token` was released (per-token emergency), or 0 if never.
    function releasedAt(address token) external view returns (uint64);

    function positionOf(uint256 positionId) external view returns (PositionView memory);

    function isListed(address token) external view returns (bool);

    function locksEnabled(address token) external view returns (bool);

    function unitAmount(address token) external view returns (uint256);

    function tierMultiplierBps(uint8 tier) external pure returns (uint256);

    /// @notice Number of weight checkpoints for `token` (at least 1 once listed: the genesis checkpoint).
    function checkpointCount(address token) external view returns (uint256);

    /// @notice Checkpoint `index` of `token`: total weight in force from `time` until the next checkpoint.
    ///         A checkpoint stamped with the current block timestamp can still change within this block.
    function checkpointAt(address token, uint256 index) external view returns (uint64 time, uint256 totalWeight);
}
