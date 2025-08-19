// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import { IPoolAddressesProvider } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IFlashLoanSimpleReceiver } from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// DEX Router Interfaces for Arbitrum
interface IUniswapV3Router {
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);
    
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}

interface ISushiSwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract FlashloanExecutor is Ownable, Pausable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    address public immutable pool;
    address public immutable provider;
    address public rootTreasury;
    address public goldstem;
    
    // DEX Router addresses on Arbitrum
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant SUSHISWAP_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    
    // Common token pairs for arbitrage
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    
    // Arbitrage parameters
    uint24 public constant UNISWAP_FEE = 3000; // 0.3%
    uint256 public constant MIN_PROFIT_THRESHOLD = 0.001 ether; // 0.001 WETH minimum profit
    uint256 public constant MAX_FLASH_AMOUNT = 100 ether; // 100 WETH max flash loan
    
    event FlashStarted(address asset, uint256 amount);
    event FlashCompleted(address asset, uint256 premium, uint256 profitWei);
    event ArbitrageExecuted(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 profit);

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

    // Calculate optimal flash loan amount based on current market conditions
    function calculateOptimalFlashAmount(address asset) public view returns (uint256 optimalAmount, uint256 expectedProfit) {
        if (asset != WETH) {
            return (0, 0); // Only support WETH for now
        }
        
        // Start with 1 WETH and calculate potential profit
        uint256 baseAmount = 1 ether;
        uint256 maxAmount = MAX_FLASH_AMOUNT;
        
        uint256 bestAmount = baseAmount;
        uint256 bestProfit = 0;
        
        // Test different amounts to find optimal
        for (uint256 amount = baseAmount; amount <= maxAmount; amount += 10 ether) {
            uint256 profit = estimateArbitrageProfit(asset, amount);
            if (profit > bestProfit) {
                bestProfit = profit;
                bestAmount = amount;
            }
        }
        
        // Only return if profit exceeds threshold
        if (bestProfit > MIN_PROFIT_THRESHOLD) {
            return (bestAmount, bestProfit);
        }
        
        return (0, 0);
    }

    // Estimate potential arbitrage profit for a given amount
    function estimateArbitrageProfit(address asset, uint256 amount) public view returns (uint256) {
        if (asset != WETH) return 0;
        
        try this.simulateArbitrage(asset, amount) returns (uint256 profit) {
            return profit;
        } catch {
            return 0;
        }
    }

    // Simulate arbitrage without executing (for estimation)
    function simulateArbitrage(address asset, uint256 amount) external pure returns (uint256) {
        // This is a simplified simulation - in practice you'd query actual DEX prices
        // For now, we'll use a conservative estimate based on typical arbitrage opportunities
        
        if (asset != WETH) return 0;
        
        // Simulate 0.1% to 0.5% arbitrage opportunity
        uint256 baseProfit = (amount * 3) / 1000; // 0.3% base profit
        
        // Use a deterministic but varied profit calculation
        uint256 adjustedProfit = baseProfit + (amount % 1000) / 1000;
        
        return adjustedProfit;
    }

    function runSimpleFlash(address asset, uint256 amount, bytes calldata params)
        external
        whenNotPaused
        nonReentrant
        onlyOwner
    {
        uint256 flashAmount = amount;
        
        // If amount is 0, calculate optimal amount
        if (flashAmount == 0) {
            (uint256 optimalAmount, ) = calculateOptimalFlashAmount(asset);
            require(optimalAmount > 0, "No profitable arbitrage opportunity found");
            flashAmount = optimalAmount;
        }
        
        require(flashAmount > 0, "amount=0");
        
        emit FlashStarted(asset, flashAmount);
        IPool(pool).flashLoanSimple(address(this), asset, flashAmount, params, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata /* params */
    ) external override returns (bool) {
        require(msg.sender == pool, "only pool");

        // Execute arbitrage strategy and capture the profit
        uint256 profit = executeArbitrageStrategy(asset, amount);

        // Ensure the profit from arbitrage is enough to cover the flash loan premium
        require(profit >= premium, "Insufficient profit to cover flash loan premium");

        // We have enough profit, so we can proceed with the repayment logic
        uint256 repayAmount = amount + premium;
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));

        // The amount to transfer to the treasury is the entire balance minus the repayment amount
        // This ensures the contract is swept clean of any remaining funds (including dust)
        uint256 amountToTreasury = currentBalance - repayAmount;

        // Transfer the net profit (and any dust) to the root treasury
        if (amountToTreasury > 0) {
            IERC20(asset).transfer(rootTreasury, amountToTreasury);
        }

        // Approve the Aave pool to pull the repayment amount
        IERC20(asset).approve(pool, 0);
        IERC20(asset).approve(pool, repayAmount);

        // Emit an event with the details of the completed flash loan
        emit FlashCompleted(asset, premium, profit - premium);
        return true;
    }

    // Execute the actual arbitrage strategy
    function executeArbitrageStrategy(address asset, uint256 amount) internal returns (uint256 profit) {
        if (asset != WETH) {
            return 0; // Only support WETH for now
        }
        
        // Strategy: WETH -> USDC -> WETH arbitrage between Uniswap V3 and SushiSwap
        try this.executeWethArbitrage(amount) returns (uint256 arbProfit) {
            return arbProfit;
        } catch Error(string memory reason) {
            // Log the specific error reason
            emit ArbitrageExecuted(WETH, USDC, amount, 0, 0);
            return 0;
        } catch {
            // If arbitrage fails for any other reason, return 0 profit
            emit ArbitrageExecuted(WETH, USDC, amount, 0, 0);
            return 0;
        }
    }

    // Execute WETH arbitrage strategy
    function executeWethArbitrage(uint256 amount) external returns (uint256 profit) {
        require(msg.sender == address(this), "Only self-call allowed");
        
        uint256 balanceBefore = IERC20(WETH).balanceOf(address(this));
        
        // Step 1: Swap WETH -> USDC on Uniswap V3
        IERC20(WETH).approve(UNISWAP_V3_ROUTER, amount);
        
        IUniswapV3Router.ExactInputSingleParams memory params = IUniswapV3Router.ExactInputSingleParams({
            tokenIn: WETH,
            tokenOut: USDC,
            fee: UNISWAP_FEE,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amount,
            amountOutMinimum: 0, // No slippage protection for arbitrage
            sqrtPriceLimitX96: 0
        });
        
        uint256 usdcAmount = IUniswapV3Router(UNISWAP_V3_ROUTER).exactInputSingle(params);
        
        // Step 2: Swap USDC -> WETH on SushiSwap
        IERC20(USDC).approve(SUSHISWAP_ROUTER, usdcAmount);
        
        address[] memory path = new address[](2);
        path[0] = USDC;
        path[1] = WETH;
        
        ISushiSwapRouter(SUSHISWAP_ROUTER).swapExactTokensForTokens(
            usdcAmount,
            0, // No slippage protection
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 balanceAfter = IERC20(WETH).balanceOf(address(this));
        profit = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        
        emit ArbitrageExecuted(WETH, USDC, amount, usdcAmount, profit);
        return profit;
    }

    // Emergency function to withdraw stuck tokens
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(owner(), balance);
        }
    }

    // Emergency function to withdraw ETH
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = owner().call{value: balance}("");
            require(success, "ETH withdrawal failed");
        }
    }
}
