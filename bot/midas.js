// bot/midas.js
require('dotenv').config({
  path: require('path').resolve(__dirname, '../contracts/.env'),
  override: true,
  quiet: true
});
const { ethers } = require('ethers');
const premiumBps = BigInt(process.env.FLASH_PREMIUM_BPS || "9"); // 9 = 0.09% (adjust if your Aave pool differs)

// Dex IDs must match the Solidity constants
const DEX = { UNIV3: 1, SUSHI_V2: 2 };

// Encode a V2 path (address[]) into bytes so the executor can abi.decode it
const encV2 = (pathArr) =>
  ethers.AbiCoder.defaultAbiCoder().encode(['address[]'], [pathArr]);


// ---- utils --------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const safeAddr = (s) => {
  if (!s) throw new Error("missing address");
  s = s.trim();
  try { return ethers.getAddress(s); }
  catch { return ethers.getAddress(s.toLowerCase()); }
};

const LOG_PROFIT_ONLY = process.env.LOG_PROFIT_ONLY === '1'; // only when qb>=need
const LOG_SAMPLE = Number(process.env.LOG_SAMPLE || 50);     // every N loops
let iter = 0;

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
  } catch { }
  const gpHex = await provider.send('eth_gasPrice', []);
  const gp = BigInt(gpHex);
  return { gasPrice: gp, maxFeePerGas: gp, maxPriorityFeePerGas: 0n };
}

// ---- chain objects ------------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC_URL);
const signer = new ethers.Wallet(process.env.SEED_KEY, provider);

// ---- config (declare BEFORE use) ----------------------------------------
const amount = BigInt(process.env.FLASH_AMOUNT_WEI || "10000000000000"); // 0.00001 WETH

// polling interval
const ADAPTIVE_POLL = (process.env.ADAPTIVE_POLL || '0') === '1';
const MIN_POLL_MS = Number(process.env.MIN_POLL_MS || 500);
const MAX_POLL_MS = Number(process.env.MAX_POLL_MS || 10_000);
let pollMs = Number(process.env.POLL_MS || 1000);
let missCount = 0;

function tunePoll(success) {
  if (!ADAPTIVE_POLL) return;
  if (success) {
    missCount = 0;
    pollMs = Math.max(MIN_POLL_MS, Math.floor(pollMs / 2));
  } else {
    missCount += 1;
    pollMs = Math.min(MAX_POLL_MS, pollMs + 500 * missCount);
  }
}

const estGas = BigInt(process.env.EST_GAS || 210000);
const safety = BigInt(process.env.SAFETY_WEI || "1000000000000");



const TOK = {
  WETH: safeAddr("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  USDCe: safeAddr("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"),
  USDC: safeAddr("0xAf88d065E77c8Cc2239327C5EDb3A432268e5831"),
  USDT: safeAddr("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
};


// pull mids from env, fallback to deep stables
const parseCsvAddrs = (csv) =>
  (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(safeAddr);

const parseCsvInts = (csv) =>
  (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(x => Number(x));


const ROUTE_MIDS = parseCsvAddrs(process.env.ROUTE_MIDS_CSV || "");
const ENABLE_SUSHI = (process.env.ENABLE_SUSHI ?? "1") === "1";
const LOG_ROUTES = (process.env.LOG_ROUTES ?? "0") === "1";


const QUOTER = safeAddr("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"); // Uniswap V3 QuoterV2
const SUSHI = safeAddr("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"); // Sushi V2 router

// --- tuning (env-overridable) ---------------------------------------------
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "15");   // 0.15% per leg
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || "2");    // require gross >= needBps + margin

const FEES = parseCsvInts(process.env.UNI_V3_FEES_CSV || "100,500,3000,10000");



// ---- ABIs / contracts ---------------------------------------------------
const artifact = require("../contracts/artifacts/contracts/FlashloanExecutor.sol/FlashloanExecutor.json");

const IQuoter = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] memory,uint32[] memory,uint256)"
]);
const ISushi = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)"
]);

const quoter = new ethers.Contract(QUOTER, IQuoter, provider); // view-only -> provider is fine
const sushi = new ethers.Contract(SUSHI, ISushi, provider); // view-only

async function bestTwoLegV3(amountInWei) {
  let best = null;
  for (const mid of ROUTE_MIDS.length ? ROUTE_MIDS : [TOK.USDC, TOK.USDCe, TOK.USDT]) {
    for (const f1 of FEES) {
      const pathAB = packV3Path([TOK.WETH, mid], [f1]);
      for (const f2 of FEES) {
        const pathBA = packV3Path([mid, TOK.WETH], [f2]);
        try {
          const [qa] = await quoter.quoteExactInput.staticCall(pathAB, amountInWei);
          const [qb] = await quoter.quoteExactInput.staticCall(pathBA, qa);
          if (!best || qb > best.qb) best = { dexA: 'uni', dexB: 'uni', pathAB, pathBA, qa, qb, hops: '1-1', mids: [mid] };
        } catch { }
      }
      for (const mid2 of ROUTE_MIDS.length ? ROUTE_MIDS : [TOK.USDC, TOK.USDCe, TOK.USDT]) if (mid2 !== mid) {
        for (const g1 of FEES) {
          const pathAB2 = packV3Path([TOK.WETH, mid, mid2], [f1, g1]);
          for (const h1 of FEES) {
            const pathBA2 = packV3Path([mid2, mid, TOK.WETH], [h1, f1]);
            try {
              const [qa] = await quoter.quoteExactInput.staticCall(pathAB2, amountInWei);
              const [qb] = await quoter.quoteExactInput.staticCall(pathBA2, qa);
              if (!best || qb > best.qb) best = { dexA: 'uni', dexB: 'uni', pathAB: pathAB2, pathBA: pathBA2, qa, qb, hops: '2-2', mids: [mid, mid2] };
            } catch { }
          }
        }
      }
    }
  }
  return best;
}


async function bestTwoLegV2(amountInWei) {
  const mids = ROUTE_MIDS;
  let best = null;

  for (const mid of mids) {
    // 1-1 path
    try {
      const a = await sushi.getAmountsOut(amountInWei, [TOK.WETH, mid]);
      const qa = a[a.length - 1];
      const b = await sushi.getAmountsOut(qa, [mid, TOK.WETH]);
      const qb = b[b.length - 1];
      if (!best || qb > best.qb) best = { dexA: 'sushi', dexB: 'sushi', pathA: [TOK.WETH, mid], pathB: [mid, TOK.WETH], qa, qb, hops: '1-1', mids: [mid] };
    } catch { }

    // 2-2 path
    for (const mid2 of mids) if (mid2 !== mid) {
      try {
        const a = await sushi.getAmountsOut(amountInWei, [TOK.WETH, mid, mid2]);
        const qa = a[a.length - 1];
        const b = await sushi.getAmountsOut(qa, [mid2, mid, TOK.WETH]);
        const qb = b[b.length - 1];
        if (!best || qb > best.qb) best = { dexA: 'sushi', dexB: 'sushi', pathA: [TOK.WETH, mid, mid2], pathB: [mid2, mid, TOK.WETH], qa, qb, hops: '2-2', mids: [mid, mid2] };
      } catch { }
    }
  }
  return best;
}

async function bestTwoLegCross(amountInWei) {
  const mids = ROUTE_MIDS.length ? ROUTE_MIDS : [TOK.USDC, TOK.USDCe, TOK.USDT];
  let best = null;

  for (const mid of mids) {
    // ---------- UNI -> SUSHI (1-1) ----------
    for (const f1 of FEES) {
      try {
        const pathV3A = packV3Path([TOK.WETH, mid], [f1]);
        const [qa] = await quoter.quoteExactInput.staticCall(pathV3A, amountInWei);
        const pathV2B = [mid, TOK.WETH];
        const b = await sushi.getAmountsOut(qa, pathV2B);
        const qb = b[b.length - 1];
        if (!best || qb > best.qb) best = {
          dexA: 'uni', dexB: 'sushi', pathAB: pathV3A, pathB: pathV2B,
          qa, qb, hops: '1-1', mids: [mid]
        };
      } catch {}
    }

    // ---------- SUSHI -> UNI (1-1) ----------
    try {
      const pathV2A = [TOK.WETH, mid];
      const a = await sushi.getAmountsOut(amountInWei, pathV2A);
      const qa = a[a.length - 1];
      for (const f2 of FEES) {
        try {
          const pathV3B = packV3Path([mid, TOK.WETH], [f2]);
          const [qb] = await quoter.quoteExactInput.staticCall(pathV3B, qa);
          if (!best || qb > best.qb) best = {
            dexA: 'sushi', dexB: 'uni', pathA: pathV2A, pathBA: pathV3B,
            qa, qb, hops: '1-1', mids: [mid]
          };
        } catch {}
      }
    } catch {}

    // ---------- 2-2 variants ----------
    for (const mid2 of mids) if (mid2 !== mid) {
      // UNI -> SUSHI (2-2)
      for (const f1 of FEES) for (const g1 of FEES) {
        try {
          const pathV3A2 = packV3Path([TOK.WETH, mid, mid2], [f1, g1]);
          const [qa] = await quoter.quoteExactInput.staticCall(pathV3A2, amountInWei);
          const pathV2B2 = [mid2, mid, TOK.WETH];
          const b2 = await sushi.getAmountsOut(qa, pathV2B2);
          const qb = b2[b2.length - 1];
          if (!best || qb > best.qb) best = {
            dexA: 'uni', dexB: 'sushi', pathAB: pathV3A2, pathB: pathV2B2,
            qa, qb, hops: '2-2', mids: [mid, mid2]
          };
        } catch {}
      }

      // SUSHI -> UNI (2-2)
      try {
        const pathV2A2 = [TOK.WETH, mid, mid2];
        const a2 = await sushi.getAmountsOut(amountInWei, pathV2A2);
        const qa = a2[a2.length - 1];
        for (const h1 of FEES) for (const fRet of FEES) {
          try {
            const pathV3B2 = packV3Path([mid2, mid, TOK.WETH], [h1, fRet]);
            const [qb] = await quoter.quoteExactInput.staticCall(pathV3B2, qa);
            if (!best || qb > best.qb) best = {
              dexA: 'sushi', dexB: 'uni', pathA: pathV2A2, pathBA: pathV3B2,
              qa, qb, hops: '2-2', mids: [mid, mid2]
            };
          } catch {}
        }
      } catch {}
    }
  }

  return best;
}

async function main() {
  const exeAdr = safeAddr(process.env.FLASH_EXECUTOR_ADDRESS);

  const net = await provider.getNetwork();
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
      // --- fees & thresholds ---
      const fee = await getFees(provider);
      const gas = (fee.gasPrice ?? fee.maxFeePerGas ?? 0n);
      const minProfitWei = gas * estGas + safety;
      const premiumWei = (amount * premiumBps) / 10_000n;
      const need = amount + minProfitWei + premiumWei;
  
      // --- route search: Uni, Sushi, Cross ---
      const [uni, v2, cross] = await Promise.all([
        bestTwoLegV3(amount),
        ENABLE_SUSHI ? bestTwoLegV2(amount) : null,
        ENABLE_SUSHI ? bestTwoLegCross(amount) : null,
      ]);
  
      // pick the route with highest qb
      let best = uni;
      for (const cand of [v2, cross]) if (cand && (!best || cand.qb > best.qb)) best = cand;
      if (!best) { console.log("skip: no route"); tunePoll(false); await sleep(pollMs); continue; }
  
      const grossBps = Number(((best.qb - amount) * 10_000n) / amount);
      const needBps  = Number(((need   - amount) * 10_000n) / amount);
  
      if (best.qb < need || grossBps < (needBps + MIN_EDGE_BPS)) {
        console.log("skip", { grossBps, needBps, need: need.toString(), hops: best.hops,
          dexA: best.dexA, dexB: best.dexB, mids: best.mids?.length || 0 });
        tunePoll(false);
        await sleep(pollMs);
        continue;
      }
  
      // --- slippage guards ---
      const minOutA = best.qa - (best.qa * SLIPPAGE_BPS) / 10_000n;
      const minOutB = best.qb - (best.qb * SLIPPAGE_BPS) / 10_000n;
  
      // --- build executor params (dex ids + bytes data) ---
      let dexAId, dataA, dexBId, dataB;
      if (best.dexA === 'uni') { dexAId = DEX.UNIV3;  dataA = best.pathAB; }
      else                     { dexAId = DEX.SUSHI_V2; dataA = encV2(best.pathA); }
  
      if (best.dexB === 'uni') { dexBId = DEX.UNIV3;  dataB = best.pathBA; }
      else                     { dexBId = DEX.SUSHI_V2; dataB = encV2(best.pathB); }
  
      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint8','bytes','uint8','bytes','uint256','uint256','uint256'],
        [ dexAId, dataA, dexBId, dataB, minOutA, minOutB, minProfitWei ]
      );
  
      // --- simulate then send ---
      try {
        await exe.runSimpleFlash.staticCall(TOK.WETH, amount, params);
      } catch (e) {
        const msg = (e.reason || e.shortMessage || e.message || "").toLowerCase();
        if (msg.includes("not profitable")) { console.log("sim: not profitable — skipping"); tunePoll(false); await sleep(pollMs); continue; }
        throw e;
      }
  
      const tx = await exe.runSimpleFlash(TOK.WETH, amount, params, { gasLimit: 2_100_000 });
      const rcpt = await tx.wait();
      console.log("done", { hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString(),
        dexA: best.dexA, dexB: best.dexB, hops: best.hops });
      tunePoll(true);
  
    } catch (e) {
      console.error("err", e.shortMessage || e.message);
      if (e.stack) console.error(e.stack);
      tunePoll(false);
    }
    await sleep(pollMs);
  }

}

main().catch((e) => { console.error(e); process.exit(1); });
 