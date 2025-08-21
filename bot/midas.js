// bot/midas.js
const path = require('path');
const fs = require('fs');

require('dotenv').config({
  path: path.resolve(__dirname, '../contracts/.env'),
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

// ---- logging / sampling -------------------------------------------------
const LOG_ROUTES     = (process.env.LOG_ROUTES     ?? "1") === "1";
const LOG_PROFIT_ONLY= (process.env.LOG_PROFIT_ONLY?? "0") === "1";
const LOG_SAMPLE     = Number(process.env.LOG_SAMPLE || 1);
let iter = 0;

// ---- DEX ids (must match Solidity executor) -----------------------------
const DEX_UNIV3   = 1;
const DEX_SUSHI_V2= 2;

// ---- chain objects ------------------------------------------------------
const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC_URL);
const signer   = new ethers.Wallet(process.env.SEED_KEY, provider);

// ---- config (declare BEFORE use) ----------------------------------------
const premiumBps = BigInt(process.env.FLASH_PREMIUM_BPS || "9"); // 0.09%
const estGas     = BigInt(process.env.EST_GAS || 210000);
const safety     = BigInt(process.env.SAFETY_WEI || "1000000000000"); // 0.000001 WETH
const defaultAmt = BigInt(process.env.FLASH_AMOUNT_WEI || "10000000000000000"); // 0.01 WETH

// polling (adaptive optional)
const ADAPTIVE_POLL = (process.env.ADAPTIVE_POLL || '0') === '1';
const MIN_POLL_MS   = Number(process.env.MIN_POLL_MS || 500);
const MAX_POLL_MS   = Number(process.env.MAX_POLL_MS || 10000);
let pollMs          = Number(process.env.POLL_MS || 1000);
let missCount       = 0;
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

// ---- tokens -------------------------------------------------------------
const TOK = {
  WETH:  safeAddr("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  USDCe: safeAddr("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"),
  USDC:  safeAddr("0xAf88d065E77c8Cc2239327C5EDb3A432268e5831"),
  USDT:  safeAddr("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
};

// ---- helpers ------------------------------------------------------------
const parseCsvAddrs = (csv) =>
  (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(safeAddr);

const parseCsvInts = (csv) =>
  (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(x => Number(x));

const parseCsvBigInts = (csv) =>
  (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(x => BigInt(x));

// 20-byte token + 3-byte fee + 20-byte token (+ ...)
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

// encode V2 path (address[]) as bytes for the executor
const encV2 = (addrArray) =>
  ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [addrArray]);

// Robust fee fetch on Arbitrum (EIP-1559 fields may be null)
async function getFees(provider) {
  try {
    const d = await provider.getFeeData();
    if (d && (d.maxFeePerGas || d.gasPrice)) return d;
  } catch { /* ignore */ }
  const gpHex = await provider.send('eth_gasPrice', []);
  const gp = BigInt(gpHex);
  return { gasPrice: gp, maxFeePerGas: gp, maxPriorityFeePerGas: 0n };
}

// ---- mids / fees / flags ------------------------------------------------
const ENABLE_SUSHI = (process.env.ENABLE_SUSHI ?? "1") === "1";
const FEES = parseCsvInts(process.env.UNI_V3_FEES_CSV || "500,3000");
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "15"); // 0.15% per leg
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || "1");

// dynamic mids: env + small built-in + optional remote cache
let ROUTE_MIDS = [];

async function loadDefaultTokenList() {
  const cfgPath = path.resolve(__dirname, 'tokenlist.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const json = JSON.parse(raw);
      if (Array.isArray(json.tokens)) return json.tokens.map(safeAddr);
    } catch { /* ignore */ }
  }

  // best-effort remote list (Node 18 has global fetch)
  try {
    const res = await fetch('https://tokens.coingecko.com/arbitrum/all.json');
    if (res.ok) {
      const data = await res.json();
      const tokens = data.tokens
        .filter(t => t.chainId === 42161)
        .slice(0, 20)
        .map(t => safeAddr(t.address));
      fs.writeFileSync(cfgPath, JSON.stringify({ tokens }, null, 2));
      return tokens;
    }
  } catch { /* offline ok */ }

  // small safe fallback
  return [
    TOK.USDC, TOK.USDCe, TOK.USDT,
    safeAddr('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'), // WBTC
    safeAddr('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'), // DAI
    safeAddr('0x912CE59144191C1204E64559FE8253a0e49E6548'), // ARB
  ];
}

async function loadRouteMids() {
  const defaults = await loadDefaultTokenList();
  const envMids  = parseCsvAddrs(process.env.ROUTE_MIDS_CSV || "");
  const merged   = [...defaults, ...envMids];
  // de-dup (case-insensitive)
  return Array.from(new Set(merged.map(a => a.toLowerCase()))).map(safeAddr);
}

// ---- on-chain helpers / ABIs -------------------------------------------
const QUOTER = safeAddr("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"); // Uniswap V3 QuoterV2
const SUSHI  = safeAddr("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"); // Sushi V2 router

const artifact = require("../contracts/artifacts/contracts/FlashloanExecutor.sol/FlashloanExecutor.json");

const IQuoter = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] memory,uint32[] memory,uint256)"
]);
const ISushi = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)"
]);

const quoter = new ethers.Contract(QUOTER, IQuoter, provider); // view-only
const sushi  = new ethers.Contract(SUSHI,  ISushi,  provider); // view-only

// ---- route finders ------------------------------------------------------
async function bestTwoLegV3(amountIn) {
  let best = null;
  for (const mid of ROUTE_MIDS) {
    for (const f1 of FEES) {
      const pathAB = packV3Path([TOK.WETH, mid], [f1]);
      for (const f2 of FEES) {
        const pathBA = packV3Path([mid, TOK.WETH], [f2]);
        try {
          const [qa] = await quoter.quoteExactInput.staticCall(pathAB, amountIn);
          const [qb] = await quoter.quoteExactInput.staticCall(pathBA, qa);
          if (!best || qb > best.qb) best = { dexA:'uni', dataA:pathAB, dexB:'uni', dataB:pathBA, qa, qb, hops:'1-1', mids:[mid] };
        } catch { /* ignore */ }
      }
      for (const mid2 of ROUTE_MIDS) if (mid2 !== mid) {
        for (const g1 of FEES) {
          const pathAB2 = packV3Path([TOK.WETH, mid, mid2], [f1,g1]);
          for (const h1 of FEES) {
            const pathBA2 = packV3Path([mid2, mid, TOK.WETH], [h1,f1]);
            try {
              const [qa] = await quoter.quoteExactInput.staticCall(pathAB2, amountIn);
              const [qb] = await quoter.quoteExactInput.staticCall(pathBA2, qa);
              if (!best || qb > best.qb) best = { dexA:'uni', dataA:pathAB2, dexB:'uni', dataB:pathBA2, qa, qb, hops:'2-2', mids:[mid,mid2] };
            } catch { /* ignore */ }
          }
        }
      }
    }
  }
  return best;
}

async function bestTwoLegV2(amountIn) {
  if (!ENABLE_SUSHI) return null;
  let best = null;
  for (const mid of ROUTE_MIDS) {
    try {
      // 1-1
      let a = await sushi.getAmountsOut(amountIn, [TOK.WETH, mid]);
      const qa = a[a.length - 1];
      let b = await sushi.getAmountsOut(qa, [mid, TOK.WETH]);
      const qb = b[b.length - 1];
      if (!best || qb > best.qb) best = { dexA:'sushi', dataA:[TOK.WETH, mid], dexB:'sushi', dataB:[mid, TOK.WETH], qa, qb, hops:'1-1', mids:[mid] };
    } catch { /* ignore */ }

    for (const mid2 of ROUTE_MIDS) if (mid2 !== mid) {
      try {
        // 2-2
        let a = await sushi.getAmountsOut(amountIn, [TOK.WETH, mid, mid2]);
        const qa = a[a.length - 1];
        let b = await sushi.getAmountsOut(qa, [mid2, mid, TOK.WETH]);
        const qb = b[b.length - 1];
        if (!best || qb > best.qb) best = { dexA:'sushi', dataA:[TOK.WETH, mid, mid2], dexB:'sushi', dataB:[mid2, mid, TOK.WETH], qa, qb, hops:'2-2', mids:[mid,mid2] };
      } catch { /* ignore */ }
    }
  }
  return best;
}

async function bestTwoLegCross(amountIn) {
  if (!ENABLE_SUSHI) return null;
  let best = null;

  const tryCand = (cand) => { if (!best || cand.qb > best.qb) best = cand; };

  for (const mid of ROUTE_MIDS) {
    // UNI -> SUSHI (1-1)
    for (const f1 of FEES) {
      try {
        const v3A = packV3Path([TOK.WETH, mid], [f1]);
        const [qa] = await quoter.quoteExactInput.staticCall(v3A, amountIn);
        const arr = await sushi.getAmountsOut(qa, [mid, TOK.WETH]);
        const qb = arr[arr.length - 1];
        tryCand({ dexA:'uni', dataA:v3A, dexB:'sushi', dataB:[mid, TOK.WETH], qa, qb, hops:'1-1', mids:[mid] });
      } catch { /* ignore */ }
    }

    // SUSHI -> UNI (1-1)
    try {
      const a1 = await sushi.getAmountsOut(amountIn, [TOK.WETH, mid]);
      const qa = a1[a1.length - 1];
      for (const f2 of FEES) {
        try {
          const v3B = packV3Path([mid, TOK.WETH], [f2]);
          const [qb] = await quoter.quoteExactInput.staticCall(v3B, qa);
          tryCand({ dexA:'sushi', dataA:[TOK.WETH, mid], dexB:'uni', dataB:v3B, qa, qb, hops:'1-1', mids:[mid] });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // 2-2 variants
    for (const mid2 of ROUTE_MIDS) if (mid2 !== mid) {
      // UNI -> SUSHI
      for (const f1 of FEES) for (const g1 of FEES) {
        try {
          const v3A2 = packV3Path([TOK.WETH, mid, mid2], [f1,g1]);
          const [qa] = await quoter.quoteExactInput.staticCall(v3A2, amountIn);
          const arr2 = await sushi.getAmountsOut(qa, [mid2, mid, TOK.WETH]);
          const qb = arr2[arr2.length - 1];
          tryCand({ dexA:'uni', dataA:v3A2, dexB:'sushi', dataB:[mid2, mid, TOK.WETH], qa, qb, hops:'2-2', mids:[mid,mid2] });
        } catch { /* ignore */ }
      }
      // SUSHI -> UNI
      try {
        const a2 = await sushi.getAmountsOut(amountIn, [TOK.WETH, mid, mid2]);
        const qa = a2[a2.length - 1];
        for (const h1 of FEES) for (const fRet of FEES) {
          try {
            const v3B2 = packV3Path([mid2, mid, TOK.WETH], [h1, fRet]);
            const [qb] = await quoter.quoteExactInput.staticCall(v3B2, qa);
            tryCand({ dexA:'sushi', dataA:[TOK.WETH, mid, mid2], dexB:'uni', dataB:v3B2, qa, qb, hops:'2-2', mids:[mid,mid2] });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }

  return best;
}

// ---- main loop ----------------------------------------------------------
async function main() {
  ROUTE_MIDS = await loadRouteMids();

  const exeAdr = safeAddr(process.env.FLASH_EXECUTOR_ADDRESS);
  const net  = await provider.getNetwork();
  const code = await provider.getCode(exeAdr);
  if (code === "0x") throw new Error(`No contract at ${exeAdr} on chainId=${net.chainId}`);

  const exe = new ethers.Contract(exeAdr, artifact.abi, signer);

  console.log("owner:", await exe.owner());
  console.log("bot start", {
    exeAdr,
    owner: await exe.owner(),
    caller: await signer.getAddress(),
    amount: defaultAmt.toString(),
    pollMs,
    estGas: estGas.toString(),
    safety: safety.toString(),
    routeMids: ROUTE_MIDS.length,
    fees: FEES.join(','),
    enableSushi: ENABLE_SUSHI
  });

  const sizes = parseCsvBigInts(process.env.SIZE_WEI_CSV || defaultAmt.toString());
  if (!sizes.length) sizes.push(defaultAmt);

  let hb = 0;

  while (true) {
    try {
      if ((++hb % 10) === 0) console.log(`tick ${new Date().toISOString()} pollMs=${pollMs}`);

      const f   = await getFees(provider);
      const gas = (f.gasPrice ?? f.maxFeePerGas ?? 0n);

      // sweep sizes and DEX combos; pick highest absolute profit (qb - amount)
      let pick = null; // { amount, dexA, dexB, dataA, dataB, qa, qb, hops, mids }
      for (const a of sizes) {
        const uni   = await bestTwoLegV3(a);
        const v2    = await bestTwoLegV2(a);
        const cross = await bestTwoLegCross(a);

        for (const cand of [uni, v2, cross]) {
          if (!cand) continue;
          const wrapped = { ...cand, amount: a };
          if (!pick || (wrapped.qb - a) > (pick.qb - pick.amount)) pick = wrapped;
        }
      }

      if (!pick) { console.log("skip: no route"); tunePoll(false); await sleep(pollMs); continue; }

      // economics (per chosen size)
      const premiumWei   = (pick.amount * premiumBps) / 10_000n;
      const minProfitWei = gas * estGas + safety;
      const need         = pick.amount + minProfitWei + premiumWei;
      const grossBps     = Number(((pick.qb - pick.amount) * 10_000n) / pick.amount);
      const needBps      = Number(((need - pick.amount) * 10_000n) / pick.amount);

      if (LOG_ROUTES && (!LOG_PROFIT_ONLY || pick.qb >= need) && (++iter % LOG_SAMPLE === 0)) {
        const midsPretty = (pick.mids || []).map(a => a.slice(0,6)+'…'+a.slice(-4)).join('→') || '-';
        console.log(`route ${pick.dexA}/${pick.dexB} ${pick.hops} ${midsPretty} grossBps=${grossBps} needBps=${needBps} amt=${pick.amount.toString()}`);
      }

      if (pick.qb < need || grossBps < (needBps + MIN_EDGE_BPS)) {
        console.log("skip", { grossBps, needBps, need: need.toString(), hops: pick.hops, dexA: pick.dexA, dexB: pick.dexB, mids: pick.mids?.length || 0 });
        tunePoll(false);
        await sleep(pollMs);
        continue;
      }

      // slippage guards per leg
      const minOutA = pick.qa - (pick.qa * SLIPPAGE_BPS) / 10_000n;
      const minOutB = pick.qb - (pick.qb * SLIPPAGE_BPS) / 10_000n;

      // pack leg data to bytes depending on dex
      const dexAId  = (pick.dexA === 'uni') ? DEX_UNIV3 : DEX_SUSHI_V2;
      const dexBId  = (pick.dexB === 'uni') ? DEX_UNIV3 : DEX_SUSHI_V2;
      const dataA   = (pick.dexA === 'uni') ? pick.dataA : encV2(pick.dataA);
      const dataB   = (pick.dexB === 'uni') ? pick.dataB : encV2(pick.dataB);

      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","bytes","uint8","bytes","uint256","uint256","uint256"],
        [dexAId, dataA, dexBId, dataB, minOutA, minOutB, minProfitWei]
      );

      // simulate then execute
      try {
        await exe.runSimpleFlash.staticCall(TOK.WETH, pick.amount, params);
      } catch (e) {
        const msg = (e.reason || e.shortMessage || e.message || "").toLowerCase();
        if (msg.includes("not profitable")) { console.log("sim: not profitable — skipping"); tunePoll(false); await sleep(pollMs); continue; }
        throw e;
      }

      const tx   = await exe.runSimpleFlash(TOK.WETH, pick.amount, params, { gasLimit: 2_000_000 });
      const rcpt = await tx.wait();
      console.log("done", { hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString(), dexA: pick.dexA, dexB: pick.dexB, hops: pick.hops });
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
