// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  DecloudToken
 * @notice Full ERC-20 DCLD token for Decloud storage deals on Sepolia.
 *         Supports approve/allowance/transferFrom required by StorageEscrow.
 *         Owner can mint tokens to distribute to clients and peers.
 */
contract DecloudToken {
    string  public constant name     = "Decloud Test Token";
    string  public constant symbol   = "DCLD";
    uint8   public constant decimals = 18;

    address public owner;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        owner       = msg.sender;
        totalSupply = initialSupply * 10 ** decimals;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to]         += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "Insufficient balance");
        require(allowance[from][msg.sender] >= value, "Insufficient allowance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to]   += value;
        emit Transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external onlyOwner {
        totalSupply   += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
