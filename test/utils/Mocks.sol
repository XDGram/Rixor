// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev TEST FIXTURES ONLY. None of these tokens represent $WIF or any real asset.

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spend(from, amount);
        _transfer(from, to, amount);
        return true;
    }

    function _spend(address from, uint256 amount) internal {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Takes a 1% fee on every transfer. Must be rejected by the Locker.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 18) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @dev transferFrom returns false without reverting. Must be rejected.
contract FalseReturnToken is MockERC20 {
    constructor() MockERC20("False Token", "FALSE", 18) {}

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @dev USDT-style: transfer and transferFrom return nothing. Compatible.
contract NoReturnToken {
    string public name = "No Return";
    string public symbol = "NORET";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount && balanceOf[from] >= amount, "denied");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Reverts on transfers to the burn address, exercising the retained-fee path.
contract BlocksDeadToken is MockERC20 {
    constructor() MockERC20("No Dead", "NODEAD", 18) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(to != 0x000000000000000000000000000000000000dEaD, "dead blocked");
        super._transfer(from, to, amount);
    }
}

/// @dev Calls back into a target during transfers to probe reentrancy guards.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public reentered;
    bool public lastCallSucceeded;

    constructor() MockERC20("Reentrant", "REENT", 18) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (target != address(0) && !reentered) {
            reentered = true;
            (lastCallSucceeded,) = target.call(payload);
        }
    }
}

/// @dev Decimals outside the supported 6-18 range.
contract BadDecimalsToken is MockERC20 {
    constructor() MockERC20("Bad Decimals", "BAD", 2) {}
}

/// @dev Minimal contract owner standing in for a Safe in unit tests. Fork tests use a real Safe.
contract MockSafe {
    address public immutable operator;

    constructor(address operator_) {
        operator = operator_;
    }

    function exec(address to, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == operator, "not operator");
        bool ok;
        (ok, result) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
