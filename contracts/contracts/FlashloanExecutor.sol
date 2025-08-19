// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import { IPoolAddressesProvider } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IFlashLoanSimpleReceiver } from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FlashloanExecutor is Ownable, Pausable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    address public immutable pool;
    address public immutable provider;
    address public rootTreasury;
    address public goldstem;

    event FlashStarted(address asset, uint256 amount);
    event FlashCompleted(address asset, uint256 premium, uint256 profitWei);

    constructor(address _provider, address _goldstem, address _rootTreasury)
        Ownable(msg.sender) // if OZ v5; remove if using OZ v4
    {
        require(_provider != address(0) && _goldstem != address(0) && _rootTreasury != address(0), "zero addr");
        provider = _provider;
        pool = IPoolAddressesProvider(_provider).getPool();
        goldstem = _goldstem;
        rootTreasury = _rootTreasury;
    }

    function setGoldstem(address a) external onlyOwner { goldstem = a; }
    function setRootTreasury(address a) external onlyOwner { rootTreasury = a; }

    // Required by IFlashLoanSimpleReceiver interface
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider) {
        return IPoolAddressesProvider(provider);
    }

    function POOL() external view returns (IPool) {
        return IPool(pool);
    }

    function runSimpleFlash(address asset, uint256 amount, bytes calldata params)
        external
        whenNotPaused
        nonReentrant
        onlyOwner
    {
        require(amount > 0, "amount=0");
        emit FlashStarted(asset, amount);
        IPool(pool).flashLoanSimple(address(this), asset, amount, params, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata /* params */
    ) external override returns (bool) {
        require(msg.sender == pool, "only pool");

        // TODO: do swaps/arb here; for dry-run, do nothing

        // repay loan (approve pool to pull)
        uint256 repay = amount + premium;
        IERC20(asset).approve(pool, 0);
        IERC20(asset).approve(pool, repay);

        // profit = whatever remains after repay
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 profit = bal > repay ? bal - repay : 0;
        if (profit > 0) {
            IERC20(asset).transfer(rootTreasury, profit);
        }
        emit FlashCompleted(asset, premium, profit);
        return true;
    }
}
