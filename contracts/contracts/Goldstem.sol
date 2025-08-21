// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Goldstem {
    address public owner;
    address public fruitWallet;
    address public branchesWallet;

    // Percentage split for fruit and branches wallets. Must total 100.
    uint256 public fruitShare = 20;
    uint256 public branchesShare = 80;

    event FundsSplit(address indexed from, uint256 amount, uint256 fruitAmount, uint256 branchesAmount);

    constructor(address _fruitWallet, address _branchesWallet) {
        owner = msg.sender;
        fruitWallet = _fruitWallet;
        branchesWallet = _branchesWallet;
    }

    receive() external payable {
        if (msg.value == 0) {
            return;
        }

        uint256 totalAmount = msg.value;
        uint256 fruitAmount = (totalAmount * fruitShare) / 100;
        uint256 branchesAmount = (totalAmount * branchesShare) / 100;

        (bool success1, ) = fruitWallet.call{value: fruitAmount}("");
        require(success1, "Failed to send funds to fruit wallet");

        (bool success2, ) = branchesWallet.call{value: branchesAmount}("");
        require(success2, "Failed to send funds to branches wallet");

        emit FundsSplit(msg.sender, totalAmount, fruitAmount, branchesAmount);
    }

    function setWallets(address _fruitWallet, address _branchesWallet) public {
        require(msg.sender == owner, "Only owner can set wallets");
        fruitWallet = _fruitWallet;
        branchesWallet = _branchesWallet;
    }

    function setShares(uint256 _fruitShare, uint256 _branchesShare) public {
        require(msg.sender == owner, "Only owner can set shares");
        require(_fruitShare + _branchesShare == 100, "Shares must add up to 100");
        fruitShare = _fruitShare;
        branchesShare = _branchesShare;
    }

    function withdraw() public {
        require(msg.sender == owner, "Only owner can withdraw");
        (bool success, ) = owner.call{value: address(this).balance}("");
        require(success, "Failed to withdraw funds");
    }
}
