// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title RixorTestToken
/// @notice TESTNET ONLY. A plain, fixed-behaviour ERC-20 used to demonstrate Rixor on Robinhood Chain testnet.
///         It has no value and represents no real asset. Every name ends in "(TEST)" and every symbol starts with
///         "t" so it cannot be mistaken for a real token.
///
///         - Exact transfers, no fees, no owner, no pause, no blacklist, no upgrade.
///         - `faucet()`: anyone may claim `faucetAmount` once per `FAUCET_COOLDOWN`, so testers need no deposit.
///           This unlimited mint is acceptable only because the token is valueless; a real listing would fail
///           Rixor's vetting rules for exactly this reason.
///         - The constructor refuses Robinhood Chain mainnet (4663).
contract RixorTestToken {
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    uint256 internal constant MAINNET = 4663;

    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable faucetAmount;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error MainnetNotAllowed();
    error FaucetCooldown(uint256 availableAt);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address recipient,
        uint256 faucetAmount_
    ) {
        if (block.chainid == MAINNET) revert MainnetNotAllowed();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        faucetAmount = faucetAmount_;
        _mint(recipient, initialSupply);
    }

    function faucet() external returns (uint256) {
        uint256 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        return faucetAmount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
