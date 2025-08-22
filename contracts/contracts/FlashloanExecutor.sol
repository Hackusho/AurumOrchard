// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IFlashLoanSimpleReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV3Router {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV2RouterLike {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

contract FlashloanExecutor is Ownable, Pausable, ReentrancyGuard, IFlashLoanSimpleReceiver {
    // ---- Aave ----
    address public immutable provider;
    address public immutable pool;

    // ---- Treasury / Ops ----
    address public rootTreasury;
    address public goldstem;

    // ---- Routers (Arbitrum) ----
    address public uniswapV3Router;
    address public sushiV2Router;

    // ---- Tokens commonly used (not required, but handy to reference) ----
    address public constant WETH  = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    // ---- Dex IDs ----
    uint8 private constant DEX_UNIV3 = 1;
    uint8 private constant DEX_SUSHI_V2 = 2;

    // ---- Events ----
    event FlashStarted(address indexed asset, uint256 amount);
    event FlashCompleted(address indexed asset, uint256 premium, uint256 profitWei);
    event LegExecuted(uint8 indexed dex, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address _provider, address _goldstem, address _rootTreasury)
        Ownable(msg.sender) // OZ v5 style; for OZ v4, remove arg and call _transferOwnership(msg.sender)
    {
        require(_provider != address(0) && _goldstem != address(0) && _rootTreasury != address(0), "zero addr");
        provider = _provider;
        pool = IPoolAddressesProvider(_provider).getPool();
        goldstem = _goldstem;
        rootTreasury = _rootTreasury;

        uniswapV3Router = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
        sushiV2Router = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    }

    // Admin
    function setGoldstem(address a) external onlyOwner { goldstem = a; }
    function setRootTreasury(address a) external onlyOwner { rootTreasury = a; }
    function setRouters(address _uniswapV3Router, address _sushiV2Router) external onlyOwner {
        uniswapV3Router = _uniswapV3Router;
        sushiV2Router = _sushiV2Router;
    }

    // Aave interfaces required
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider) { return IPoolAddressesProvider(provider); }
    function POOL() external view returns (IPool) { return IPool(pool); }

    // ---- Bytes path helpers (UniV3) ----
    function _firstTokenV3(bytes memory path) internal pure returns (address token) {
        require(path.length >= 20, "v3 path short");
        assembly { token := shr(96, mload(add(path, 32))) }
    }

    function _lastTokenV3(bytes memory path) internal pure returns (address token) {
        require(path.length >= 20, "v3 path short");
        uint256 len = path.length;
        uint256 index = len - 20;
        assembly { token := shr(96, mload(add(add(path, 32), index))) }
    }

    // ---- Encoded address[] helpers (V2) ----
    function _firstTokenV2(bytes memory encodedPath) internal pure returns (address token) {
        address[] memory p = abi.decode(encodedPath, (address[]));
        require(p.length >= 2, "v2 path short");
        token = p[0];
    }

    function _lastTokenV2(bytes memory encodedPath) internal pure returns (address token) {
        address[] memory p = abi.decode(encodedPath, (address[]));
        require(p.length >= 2, "v2 path short");
        token = p[p.length - 1];
    }

    function _startTokenByDex(uint8 dex, bytes memory data) internal pure returns (address) {
        if (dex == DEX_UNIV3) return _firstTokenV3(data);
        if (dex == DEX_SUSHI_V2) return _firstTokenV2(data);
        revert("bad dex A");
    }

    function _endTokenByDex(uint8 dex, bytes memory data) internal pure returns (address) {
        if (dex == DEX_UNIV3) return _lastTokenV3(data);
        if (dex == DEX_SUSHI_V2) return _lastTokenV2(data);
        revert("bad dex B");
    }

    // ---- Flash entry ----
    /// params encoding:
    /// (uint8 dexA, bytes dataA, uint8 dexB, bytes dataB, uint256 minOutA, uint256 minOutB, uint256 minProfitWei)
    function runSimpleFlash(address asset, uint256 amount, bytes calldata params)
        external
        whenNotPaused
        nonReentrant
        onlyOwner
    {
        require(amount > 0, "amount=0"); // amount sizing is done off-chain
        emit FlashStarted(asset, amount);

        IPool(pool).flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0
        );
    }

    // ---- Aave callback ----
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /*initiator*/,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == pool, "only pool");

        (uint8 dexA, bytes memory dataA, uint8 dexB, bytes memory dataB, uint256 minOutA, uint256 minOutB, uint256 minProfitWei)
            = abi.decode(params, (uint8, bytes, uint8, bytes, uint256, uint256, uint256));

        // Validate leg chaining
        address a0 = _startTokenByDex(dexA, dataA);
        address aN = _endTokenByDex(dexA, dataA);
        address b0 = _startTokenByDex(dexB, dataB);
        address bN = _endTokenByDex(dexB, dataB);

        require(a0 == asset, "legA start != asset");
        require(bN == asset, "legB end != asset");
        require(aN == b0, "legs not chained");

        uint256 balBefore = IERC20(asset).balanceOf(address(this));

        // Leg A
        uint256 interAmount = _swap(dexA, dataA, amount, minOutA);

        // Leg B
        _swap(dexB, dataB, interAmount, minOutB);

        uint256 balAfter = IERC20(asset).balanceOf(address(this));
        uint256 realized = balAfter > balBefore ? balAfter - balBefore : 0;

        // Must cover Aave premium + our required profit buffer
        require(realized >= premium + minProfitWei, "not profitable");

        // Repay Aave
        uint256 repay = amount + premium;
        IERC20(asset).approve(pool, repay);

        // Send profit to treasury
        uint256 profitWei = balAfter - repay;
        if (profitWei > 0) {
            IERC20(asset).transfer(rootTreasury, profitWei);
        }

        emit FlashCompleted(asset, premium, profitWei);
        return true;
    }

    // ---- Internal swap dispatcher ----
    function _swap(uint8 dex, bytes memory data, uint256 amountIn, uint256 amountOutMin) internal returns (uint256 out) {
        if (dex == DEX_UNIV3) {
            address tokenIn = _firstTokenV3(data);
            address tokenOut = _lastTokenV3(data);

            IERC20(tokenIn).approve(uniswapV3Router, amountIn);

            out = IUniswapV3Router(uniswapV3Router).exactInput(
                IUniswapV3Router.ExactInputParams({
                    path: data,
                    recipient: address(this),
                    deadline: block.timestamp + 300,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin
                })
            );

            emit LegExecuted(dex, tokenIn, tokenOut, amountIn, out);
            return out;
        }
        if (dex == DEX_SUSHI_V2) {
            address[] memory path = abi.decode(data, (address[]));
            require(path.length >= 2 && path[0] != address(0) && path[path.length - 1] != address(0), "bad v2 path");

            address tokenIn = path[0];
            address tokenOut = path[path.length - 1];

            IERC20(tokenIn).approve(sushiV2Router, amountIn);

            uint[] memory amounts = IUniswapV2RouterLike(sushiV2Router).swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                address(this),
                block.timestamp + 300
            );
            out = amounts[amounts.length - 1];

            emit LegExecuted(dex, tokenIn, tokenOut, amountIn, out);
            return out;
        }
        revert("unknown dex");
    }

    // ---- Emergencies ----
    function emergencyWithdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner(), bal);
    }

    function emergencyWithdrawETH() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = owner().call{value: bal}("");
            require(ok, "eth withdraw failed");
        }
    }
}
