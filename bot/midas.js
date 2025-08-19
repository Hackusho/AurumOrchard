// bot/midas.js
require('dotenv').config({
  path: require('path').resolve(__dirname, '../contracts/.env'),
  override: true,
  quiet: true
});
const { ethers } = require('ethers');

// ---- utils --------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const safeAddr = (s) => {
  if (!s) throw new Error("missing address");
  s = s.trim();
  try { return ethers.getAddress(s); }
  catch { return ethers.getAddress(s.toLowerCase()); }
};

// 20-byte token + 3-byte fee + 20-byte token (+ ...)
// tokens: ["0xToken0","0xToken1",...]; fees: [500, 3000, ...] length = tokens.length - 1
const packV3Path = (tokens, fees) => {
  if (fees.length !== tokens.length - 1) throw new Error("fees length mismatch");
  const parts = [];
  for (let i = 0; i < fees.length; i++) {
    parts.push(safeAddr(tokens[i]));
    parts.push(ethers.zeroPadValue(ethers.toBeHex(fees[i]), 3));
  }
  parts.push(safeAddr(tokens[tokens.length - 1]));
  return ethers.concat(parts);
};

// Robust fee fetch on Arbitrum (EIP-1559 fields may be null)
async function getFees(provider) {
  try {
    const d = await provider.getFeeData();
    if (d && (d.maxFeePerGas || d.gasPrice)) return d;
  } catch {}
  const gpHex = await provider.send('eth_gasPrice', []);
  const gp = BigInt(gpHex);
  return { gasPrice: gp, maxFeePerGas: gp, maxPriorityFeePerGas: 0n };
}

// ---- chain objects ------------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC_URL);
const signer   = new ethers.Wallet(process.env.SEED_KEY, provider);

// ---- config (declare BEFORE use) ----------------------------------------
const amount  = BigInt(process.env.FLASH_AMOUNT_WEI || "10000000000000"); // 0.00001 WETH
const pollMs  = Number(process.env.POLL_MS || 4000);
const estGas  = BigInt(process.env.EST_GAS || 250000);
const safety  = BigInt(process.env.SAFETY_WEI || "1000000000000");
const FEES    = [100, 500, 3000, 10000];

const TOK = {
  WETH:  safeAddr("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  USDCe: safeAddr("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"),
  USDC:  safeAddr("0xAf88d065E77c8Cc2239327C5EDb3A432268e5831"),
  USDT:  safeAddr("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
};

const QUOTER = safeAddr("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"); // Uniswap V3 QuoterV2
const SUSHI  = safeAddr("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"); // Sushi V2 router

// ---- ABIs / contracts ---------------------------------------------------
const artifact = require("../contracts/artifacts/contracts/FlashloanExecutor.sol/FlashloanExecutor.json");

const IQuoter = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] memory,uint32[] memory,uint256)"
]);
const ISushi = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)"
]);

const quoter = new ethers.Contract(QUOTER, IQuoter, provider); // view-only -> provider is fine
const sushi  = new ethers.Contract(SUSHI,  ISushi,  provider); // view-only

async function bestTwoLegV3(amountInWei) {
  const bases = [TOK.USDC, TOK.USDCe, TOK.USDT];
  let best = null;

  for (const mid of bases) {
    for (const f1 of FEES) {
      // 1-hop forward, try 1-hop back with cross-fees
      const pathAB = packV3Path([TOK.WETH, mid], [f1]);
      for (const f2 of FEES) {
        const pathBA = packV3Path([mid, TOK.WETH], [f2]);
        try {
          const [qa] = await quoter.quoteExactInput.staticCall(pathAB, amountInWei);
          const [qb] = await quoter.quoteExactInput.staticCall(pathBA, qa);
          if (!best || qb > best.qb) best = { pathAB, pathBA, qa, qb, hops: "1-1" };
        } catch {}
      }

      // 2-hop forward/back (e.g., WETH->USDCe->USDC then reverse)
      for (const mid2 of bases) if (mid2 !== mid) {
        for (const g1 of FEES) {
          const pathAB2 = packV3Path([TOK.WETH, mid, mid2], [f1, g1]);
          for (const h1 of FEES) {
            const pathBA2 = packV3Path([mid2, mid, TOK.WETH], [h1, f1]);
            try {
              const [qa] = await quoter.quoteExactInput.staticCall(pathAB2, amountInWei);
              const [qb] = await quoter.quoteExactInput.staticCall(pathBA2, qa);
              if (!best || qb > best.qb) best = { pathAB: pathAB2, pathBA: pathBA2, qa, qb, hops: "2-2" };
            } catch {}
          }
        }
      }
    }
  }
  return best;
}

async function main() {
  const exeAdr = safeAddr(process.env.FLASH_EXECUTOR_ADDRESS);

  const net  = await provider.getNetwork();
  const code = await provider.getCode(exeAdr);
  if (code === "0x") throw new Error(`No contract at ${exeAdr} on chainId=${net.chainId}`);

  const exe = new ethers.Contract(exeAdr, artifact.abi, signer);
  console.log("owner:", await exe.owner());
  console.log("bot start", {
    exeAdr, owner: await exe.owner(), caller: await signer.getAddress(),
    amount: amount.toString(), pollMs, estGas: estGas.toString(), safety: safety.toString()
  });

  while (true) {
    try {
      const f = await getFees(provider);
      const gasPrice = (f.gasPrice ?? f.maxFeePerGas ?? 0n);
      const gasWei   = gasPrice * estGas;
      const minProfitWei = gasWei + safety;

      // find best 2-leg v3 -> v3 roundtrip
      const best = await bestTwoLegV3(amount);
      if (!best) { console.log("skip: no route"); await sleep(pollMs); continue; }

      // encode params to match: (bytes, bytes, uint256, uint256, uint256)
      const slippageBps = 30n; // 0.30% per leg
      const minOutA = best.qa - (best.qa * slippageBps) / 10000n;
      const minOutB = best.qb - (best.qb * slippageBps) / 10000n;

      const abi = ethers.AbiCoder.defaultAbiCoder();
      const params = abi.encode(
        ["bytes","bytes","uint256","uint256","uint256"],
        [best.pathAB, best.pathBA, minOutA, minOutB, minProfitWei]
      );

      // ensure profitable including Aave premium (staticCall)
      await exe.runSimpleFlash.staticCall(TOK.WETH, amount, params);
      console.log("fire", { hops: best.hops, qb: best.qb.toString(), minProfitWei: minProfitWei.toString(), gasWei: gasWei.toString() });

      const tx = await exe.runSimpleFlash(TOK.WETH, amount, params, { gasLimit: 2_000_000 });
      const rcpt = await tx.wait();
      console.log("done", { hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString() });

    } catch (e) {
      console.error("err", e.shortMessage || e.message);
      if (e.stack) console.error(e.stack);
    }
    await sleep(pollMs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
