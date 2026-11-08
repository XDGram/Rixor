// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRixorLocker
/// @notice Read-only surface of RixorLocker used by RixorChallenges. Nothing in this interface can
///         move tokens or change Locker state.
interface IRixorLocker {
    struct PositionView {
        address owner;
        address token;
        uint8 tier;
        uint64 startedAt;
        uint64 endsAt;
        uint64 closedAt;
        uint256 amount;
    }

    /// @notice $WIF, the protocol reward token and the only token with the higher multiplier.
    function WIF() external view returns (address);

    /// @notice Administrative owner (a Safe). Also the only account allowed to create Season challenges.
    function owner() external view returns (address);

    /// @notice True while new activity (locks, challenge creation, joins, sponsorship) is paused.
    function paused() external view returns (bool);

    /// @notice Timestamp at which emergency mode was activated, or 0 if never.
    function emergencyActivatedAt() external view returns (uint64);

    function positionOf(uint256 positionId) external view returns (PositionView memory);

    function isListed(address token) external view returns (bool);

    function locksEnabled(address token) external view returns (bool);

    function unitAmount(address token) external view returns (uint256);

    function tierMultiplierBps(uint8 tier) external pure returns (uint256);

    function tokenMultiplierBps(address token) external view returns (uint256);
}
