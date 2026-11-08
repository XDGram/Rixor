// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RixorMockPriceOracle
/// @notice MOCK price source for local tests and Robinhood Chain Testnet ONLY.
///         The price is set by hand by the deployer. It does not track any market and must
///         never be used on mainnet. A production deployment needs a real oracle adapter
///         (for example a Chainlink feed or a manipulation-resistant DEX TWAP).
contract RixorMockPriceOracle {
    string public constant description = "MOCK - manually set price, testnet only";
    address public immutable setter;
    uint256 public price;
    uint256 public updatedAt;

    event PriceSet(uint256 price, uint256 updatedAt);

    error NotSetter();

    constructor(uint256 initialPrice) {
        setter = msg.sender;
        _set(initialPrice);
    }

    function setPrice(uint256 newPrice) external {
        if (msg.sender != setter) revert NotSetter();
        _set(newPrice);
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (price, updatedAt);
    }

    function _set(uint256 newPrice) private {
        price = newPrice;
        updatedAt = block.timestamp;
        emit PriceSet(newPrice, block.timestamp);
    }
}
