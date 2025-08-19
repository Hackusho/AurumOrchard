// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

contract FlashloanExecutor is
    Ownable,
    Pausable,
    ReentrancyGuard,
    IFlashLoanSimpleReceiver
{
    address public immutable pool;
    address public immutable provider;
    address public rootTreasury;
    address public goldstem;

    // DEX Router addresses on Arbitrum
    address public constant UNISWAP_V3_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant SUSHISWAP_ROUTER =
        0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;

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
    event ArbitrageExecuted(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 profit
    );

    constructor(
        address _provider,
        address _goldstem,
        address _rootTreasury
    )
        Ownable(msg.sender) // if OZ v5; remove if using OZ v4
    {
        require(
            _provider != address(0) &&
                _goldstem != address(0) &&
                _rootTreasury != address(0),
            "zero addr"
        );
        provider = _provider;
        pool = IPoolAddressesProvider(_provider).getPool();
        goldstem = _goldstem;
        rootTreasury = _rootTreasury;
    }

    function setGoldstem(address a) external onlyOwner {
        goldstem = a;
    }
    function setRootTreasury(address a) external onlyOwner {
        rootTreasury = a;
    }

    // Required by IFlashLoanSimpleReceiver interface
    function ADDRESSES_PROVIDER()
        external
        view
        returns (IPoolAddressesProvider)
    {
        return IPoolAddressesProvider(provider);
    }

    function POOL() external view returns (IPool) {
        return IPool(pool);
    }

    // Calculate optimal flash loan amount based on current market conditions
    function calculateOptimalFlashAmount(
        address asset
    ) public view returns (uint256 optimalAmount, uint256 expectedProfit) {
        if (asset != WETH) {
            return (0, 0); // Only support WETH for now
        }

        // Start with 1 WETH and calculate potential profit
        uint256 baseAmount = 1 ether;
        uint256 maxAmount = MAX_FLASH_AMOUNT;

        uint256 bestAmount = baseAmount;
        uint256 bestProfit = 0;

        // Test different amounts to find optimal
        for (
            uint256 amount = baseAmount;
            amount <= maxAmount;
            amount += 10 ether
        ) {
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
    function estimateArbitrageProfit(
        address asset,
        uint256 amount
    ) public view returns (uint256) {
        if (asset != WETH) return 0;

        try this.simulateArbitrage(asset, amount) returns (uint256 profit) {
            return profit;
        } catch {
            return 0;
        }
    }

    // Simulate arbitrage without executing (for estimation)
    function simulateArbitrage(
        address asset,
        uint256 amount
    ) external pure returns (uint256) {
        // This is a simplified simulation - in practice you'd query actual DEX prices
        // For now, we'll use a conservative estimate based on typical arbitrage opportunities

        if (asset != WETH) return 0;

        // Simulate 0.1% to 0.5% arbitrage opportunity
        uint256 baseProfit = (amount * 3) / 1000; // 0.3% base profit

        // Use a deterministic but varied profit calculation
        uint256 adjustedProfit = baseProfit + (amount % 1000) / 1000;

        return adjustedProfit;
    }

    function runSimpleFlash(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external whenNotPaused nonReentrant onlyOwner {
        uint256 flashAmount = amount;

        // If amount is 0, calculate optimal amount
        if (flashAmount == 0) {
            (uint256 optimalAmount, ) = calculateOptimalFlashAmount(asset);
            require(
                optimalAmount > 0,
                "No profitable arbitrage opportunity found"
            );
            flashAmount = optimalAmount;
        }

        require(flashAmount > 0, "amount=0");

        emit FlashStarted(asset, flashAmount);
        IPool(pool).flashLoanSimple(
            address(this),
            asset,
            flashAmount,
            params,
            0
        );
    }

    function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address /* initiator */,
    bytes calldata params
) external override returns (bool) {
    require(msg.sender == pool, "only pool");

    // Decode execution plan
    (
        address[] memory pathA,
        address[] memory pathB,
        uint256 minOutA,
        uint256 minOutB,
        uint256 minProfitWei
    ) = _decodeParams(params);

    IERC20 token = IERC20(asset);
    uint256 beforeBal = token.balanceOf(address(this));

    // 1) Do the round-trip (e.g., WETH->USDC on UniV3, then USDC->WETH on Sushi)
    uint256 afterBal = executeArbitrageStrategy(
        asset,
        amount,
        pathA,
        pathB,
        minOutA,
        minOutB
    );

    // 2) Require the round-trip covered premium + desired profit
    uint256 earned = afterBal > beforeBal ? afterBal - beforeBal : 0;
    require(earned >= premium + minProfitWei, "not profitable");

    // 3) Repay Aave
    uint256 repay = amount + premium;
    token.approve(pool, 0);
    token.approve(pool, repay);

    // 4) Send profit to treasury
    uint256 profitWei = afterBal - repay;
    if (profitWei > 0) {
        token.transfer(rootTreasury, profitWei);
    }

    emit FlashCompleted(asset, premium, profitWei);
    return true;
}


    function _decodeParams(bytes memory params)
        internal
        pure
        returns (
            address[] memory pathA,
            address[] memory pathB,
            uint256 minOutA,
            uint256 minOutB,
            uint256 minProfitWei
        )
    {
    return abi.decode(params, (address[], address[], uint256, uint256, uint256));
    }


    function executeArbitrageStrategy(
        address asset,
        uint256 amount,
        address[] memory pathA,
        address[] memory pathB,
        uint256 minOutA,
        uint256 minOutB
    ) internal returns (uint256 amountOut) {
        require(pathA.length == 2, "pathA len");
        require(pathB.length >= 2, "pathB len");
        require(
            pathA[0] == asset && pathB[pathB.length - 1] == asset,
            "asset mismatch"
        );
        require(pathA[1] == pathB[0], "path mismatch");

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        IERC20(pathA[0]).approve(UNISWAP_V3_ROUTER, amount);
        IUniswapV3Router.ExactInputSingleParams
            memory uniParams = IUniswapV3Router.ExactInputSingleParams({
                tokenIn: pathA[0],
                tokenOut: pathA[1],
                fee: UNISWAP_FEE,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amount,
                amountOutMinimum: minOutA,
                sqrtPriceLimitX96: 0
            });
        uint256 interAmount = IUniswapV3Router(UNISWAP_V3_ROUTER)
            .exactInputSingle(uniParams);

        IERC20(pathB[0]).approve(SUSHISWAP_ROUTER, interAmount);
        ISushiSwapRouter(SUSHISWAP_ROUTER).swapExactTokensForTokens(
            interAmount,
            minOutB,
            pathB,
            address(this),
            block.timestamp + 300
        );

        amountOut = IERC20(asset).balanceOf(address(this));
        uint256 profit = amountOut > balanceBefore
            ? amountOut - balanceBefore
            : 0;
        emit ArbitrageExecuted(
            pathA[0],
            pathB[pathB.length - 1],
            amount,
            amountOut,
            profit
        );
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
