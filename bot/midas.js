"use strict";

const path = require("path");
const fs = require("fs");
require("dotenv").config({
  path: path.resolve(__dirname, "../contracts/.env"),
  override: true,
  quiet: true
});
const { ethers } = require("ethers");

// -------------------- utils --------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const safeAddr = (s) => {
  if (!s) throw new Error("missing address");
  s = s.trim();
  try { return ethers.getAddress(s); }
  catch { return ethers.getAddress(s.toLowerCase()); }
};

// Uni V3 path packer: token(20) + fee(3) + token(20) [+ ...]
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

// Encode V2 path for the executor (bytes)
const encV2 = (addrArray) => ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [addrArray]);

// Robust fee fetch on Arbitrum (EIP-1559 sometimes null)
async function getFees(provider) {
  try {
    const d = await provider.getFeeData();
    if (d && (d.maxFeePerGas || d.gasPrice)) return d;
  } catch {}
  const gpHex = await provider.send("eth_gasPrice", []);
  const gp = BigInt(gpHex);
  return { gasPrice: gp, maxFeePerGas: gp, maxPriorityFeePerGas: 0n };
}

// CSV helpers
const parseCsvAddrs = (csv) => (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(safeAddr);
const parseCsvInts  = (csv) => (csv || "").split(",").map(s => s.trim()).filter(Boolean).map(x => Number(x));

// Pretty helpers
const short = (a) => a.slice(0,6) + "…" + a.slice(-4);

// -------------------- chain objects --------------------
const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC_URL);
const signer   = new ethers.Wallet(process.env.SEED_KEY, provider);

// -------------------- config --------------------
const premiumBps = BigInt(process.env.FLASH_PREMIUM_BPS || "9"); // 9 = 0.09%
const estGas     = BigInt(process.env.EST_GAS || 230000);
const safety     = BigInt(process.env.SAFETY_WEI || "200000000000");
const amount     = BigInt(process.env.FLASH_AMOUNT_WEI || "200000000000000000"); // 0.2 WETH default

// polling
let pollMs = Number(process.env.POLL_MS || 2000);
const ADAPTIVE_POLL = (process.env.ADAPTIVE_POLL || "0") === "1";
const MIN_POLL_MS = Number(process.env.MIN_POLL_MS || 250);
const MAX_POLL_MS = Number(process.env.MAX_POLL_MS || 10_000);
let missCount = 0;
function tunePoll(success) {
  if (!ADAPTIVE_POLL) return;
  if (success) { missCount = 0; pollMs = Math.max(MIN_POLL_MS, Math.floor(pollMs / 2)); }
  else { missCount++; pollMs = Math.min(MAX_POLL_MS, pollMs + 500 * missCount); }
}

// logging knobs
const LOG_ROUTES      = (process.env.LOG_ROUTES || "0") === "1";
const LOG_SAMPLE      = Number(process.env.LOG_SAMPLE || 1);
const LOG_PROFIT_ONLY = (process.env.LOG_PROFIT_ONLY || "0") === "1";
let iter = 0, hb = 0;

// economics
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "10");
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || "1");

// addresses (Arbitrum One)
const TOK = {
  WETH:  safeAddr("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
  USDCe: safeAddr("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"),
  USDC:  safeAddr("0xAf88d065E77c8Cc2239327C5EDb3A432268e5831"),
  USDT:  safeAddr("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"),
  WBTC:  safeAddr("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f"),
  DAI:   safeAddr("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"),
  ARB:   safeAddr("0x912CE59144191C1204E64559FE8253a0e49E6548")
};

const QUOTER = safeAddr("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"); // Uni V3 QuoterV2
const SUSHI  = safeAddr("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"); // Sushi V2 router

const DEX_UNIV3    = 1;
const DEX_SUSHI_V2 = 2;

const ENABLE_SUSHI = (process.env.ENABLE_SUSHI || "1") === "1";
const FEES = parseCsvInts(process.env.UNI_V3_FEES_CSV || "100,500,3000,10000");

// -------------------- ABIs & contracts --------------------
const artifact = require("../contracts/artifacts/contracts/FlashloanExecutor.sol/FlashloanExecutor.json");
const IQuoter = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] memory,uint32[] memory,uint256)"
]);
const ISushi = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)"
]);
const quoter = new ethers.Contract(QUOTER, IQuoter, provider);
const sushi  = new ethers.Contract(SUSHI,  ISushi,  provider);

// -------------------- token list --------------------
let ROUTE_MIDS = [];
async function loadDefaultTokenList() {
  const cfgPath = path.resolve(__dirname, "tokenlist.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf8");
      const json = JSON.parse(raw);
      if (Array.isArray(json.tokens)) return json.tokens.map(safeAddr);
    } catch {}
  }
  const gfetch = (typeof fetch === "function") ? fetch : null;
  if (gfetch) {
    try {
      const res = await gfetch("https://tokens.coingecko.com/arbitrum/all.json");
      if (res.ok) {
        const data = await res.json();
        const tokens = data.tokens.filter(t => t.chainId === 42161).slice(0, 25).map(t => safeAddr(t.address));
        fs.writeFileSync(cfgPath, JSON.stringify({ tokens }, null, 2));
        return tokens;
      }
    } catch (e) { console.warn("token list fetch failed", e.message); }
  }
  // fallback minimal set
  return [TOK.USDC, TOK.USDCe, TOK.USDT, TOK.WBTC, TOK.DAI, TOK.ARB];
}
async function loadRouteMids() {
  const defaults = await loadDefaultTokenList();
  const envMids  = parseCsvAddrs(process.env.ROUTE_MIDS_CSV || "");
  const merged   = [...defaults, ...envMids];
  return Array.from(new Set(merged.map(a => a.toLowerCase()))).map(safeAddr);
}

// -------------------- routing (quoters) --------------------
async function findBestRoute(amountInWei) {
  const mids = ROUTE_MIDS.length ? ROUTE_MIDS : [TOK.USDC, TOK.USDCe, TOK.USDT];
  let best = null;

  const quoteUni = async (pathBytes, amtIn) => {
    const [out] = await quoter.quoteExactInput.staticCall(pathBytes, amtIn);
    return out;
  };
  const quoteV2 = async (addrPath, amtIn) => {
    const arr = await sushi.getAmountsOut(amtIn, addrPath);
    return arr[arr.length - 1];
  };

  async function tryCand(dexA, quoteA, sendA, dexB, quoteB, sendB, hops, midsUsed) {
    try {
      const qa = (dexA === 'uni') ? await quoteUni(quoteA, amountInWei) : await quoteV2(quoteA, amountInWei);
      const qb = (dexB === 'uni') ? await quoteUni(quoteB, qa)         : await quoteV2(quoteB, qa);
      const cand = { dexA, dexB, qa, qb, hops, mids: midsUsed, dataA: sendA, dataB: sendB };
      if (!best || qb > best.qb) best = cand;
    } catch {}
  }

  // 1-1 combos
  for (const mid of mids) {
    // uni-uni & cross
    for (const f1 of FEES) {
      const v3AB = packV3Path([TOK.WETH, mid], [f1]);
      for (const f2 of FEES) {
        const v3BA = packV3Path([mid, TOK.WETH], [f2]);
        await tryCand('uni', v3AB, v3AB, 'uni', v3BA, v3BA, '1-1', [mid]);
        if (ENABLE_SUSHI) {
          await tryCand('uni', v3AB, v3AB, 'sushi', [mid, TOK.WETH], encV2([mid, TOK.WETH]), '1-1', [mid]);
          await tryCand('sushi', [TOK.WETH, mid], encV2([TOK.WETH, mid]), 'uni', v3BA, v3BA, '1-1', [mid]);
        }
      }
      if (ENABLE_SUSHI) {
        await tryCand('sushi', [TOK.WETH, mid], encV2([TOK.WETH, mid]), 'sushi', [mid, TOK.WETH], encV2([mid, TOK.WETH]), '1-1', [mid]);
      }
    }
  }

  // 2-2 combos
  for (const mid of mids) for (const mid2 of mids) if (mid2 !== mid) {
    for (const f1 of FEES) for (const g1 of FEES) {
      const v3AB2 = packV3Path([TOK.WETH, mid, mid2], [f1, g1]);
      for (const h1 of FEES) {
        const v3BA2 = packV3Path([mid2, mid, TOK.WETH], [h1, f1]);
        await tryCand('uni', v3AB2, v3AB2, 'uni', v3BA2, v3BA2, '2-2', [mid, mid2]);
        if (ENABLE_SUSHI) {
          await tryCand('uni', v3AB2, v3AB2, 'sushi', [mid2, mid, TOK.WETH], encV2([mid2, mid, TOK.WETH]), '2-2', [mid, mid2]);
          await tryCand('sushi', [TOK.WETH, mid, mid2], encV2([TOK.WETH, mid, mid2]), 'uni', v3BA2, v3BA2, '2-2', [mid, mid2]);
          await tryCand('sushi', [TOK.WETH, mid, mid2], encV2([TOK.WETH, mid, mid2]), 'sushi', [mid2, mid, TOK.WETH], encV2([mid2, mid, TOK.WETH]), '2-2', [mid, mid2]);
        }
      }
    }
  }
  return best;
}

// -------------------- main loop --------------------
async function main() {
  ROUTE_MIDS = await loadRouteMids();
  const exeAdr = safeAddr(process.env.FLASH_EXECUTOR_ADDRESS);

  const net = await provider.getNetwork();
  const code = await provider.getCode(exeAdr);
  if (code === "0x") throw new Error(`No contract at ${exeAdr} on chainId=${net.chainId}`);

  const exe = new ethers.Contract(exeAdr, artifact.abi, signer);
  const owner = await exe.owner();
  console.log("owner:", owner);
  console.log("bot start", {
    exeAdr,
    owner,
    caller: await signer.getAddress(),
    amount: amount.toString(),
    pollMs,
    estGas: estGas.toString(),
    safety: safety.toString(),
    routeMids: ROUTE_MIDS.length,
    fees: FEES.join(','),
    enableSushi: ENABLE_SUSHI
  });

  while (true) {
    try {
      // heartbeat
      if ((++hb % 10) === 0) console.log(`tick ${new Date().toISOString()}`);
    
      // 1) fees & thresholds first
      const f = await getFees(provider);
      const gas = (f.gasPrice ?? f.maxFeePerGas ?? 0n);
      const minProfitWei = gas * estGas + safety;
      const premiumWei   = (amount * premiumBps) / 10_000n;
      const need         = amount + minProfitWei + premiumWei;
      const needBps      = Number(((need - amount) * 10_000n) / amount);
    
      // 2) pick best across Uni↔Sushi (1-1 & 2-2)
      const best = await findBestRoute(amount); // ← this tries uni/uni, uni/sushi, sushi/uni, sushi/sushi
      if (!best) { console.log("skip: no route"); tunePoll(false); await sleep(pollMs); continue; }
    
      const grossBps = Number(((best.qb - amount) * 10_000n) / amount);
      if (LOG_ROUTES) {
        const midsPretty = (best.mids || []).map(a => a.slice(0,6)+'…'+a.slice(-4)).join('→');
        console.log(`route ${best.dexA}/${best.dexB} ${best.hops} ${midsPretty} grossBps=${grossBps} needBps=${needBps}`);
      }
    
      // 3) economic gate
      if (best.qb < need || grossBps < (needBps + MIN_EDGE_BPS)) {
        console.log("skip", { grossBps, needBps, need: need.toString(), hops: best.hops, dexA: best.dexA, dexB: best.dexB, mids: best.mids?.length || 0 });
        tunePoll(false);
        await sleep(pollMs);
        continue;
      }
    
      // 4) slippage guards
      const sl = SLIPPAGE_BPS;
      const minOutA = best.qa - (best.qa * sl) / 10_000n;
      const minOutB = best.qb - (best.qb * sl) / 10_000n;
    
      // 5) encode for executor: (uint8,uint8)
      const dexAId = (best.dexA === 'uni') ? DEX_UNIV3 : DEX_SUSHI_V2;
      const dexBId = (best.dexB === 'uni') ? DEX_UNIV3 : DEX_SUSHI_V2;
    
      const params = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8","bytes","uint8","bytes","uint256","uint256","uint256"],
        [dexAId, best.dataA, dexBId, best.dataB, minOutA, minOutB, minProfitWei]
      );
    
      // 6) simulate then send
      await exe.runSimpleFlash.staticCall(TOK.WETH, amount, params).catch(e => {
        const msg = (e.reason || e.shortMessage || e.message || "").toLowerCase();
        if (msg.includes("not profitable")) {
          console.log("sim: not profitable — skipping");
          throw new Error("__softskip__");
        }
        throw e;
      });
    
      const tx = await exe.runSimpleFlash(TOK.WETH, amount, params, { gasLimit: 2_000_000 });
      const rcpt = await tx.wait();
      console.log("done", { hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString(), dexA: best.dexA, dexB: best.dexB, hops: best.hops });
      tunePoll(true);
    
    } catch (e) {
      if (e.message !== "__softskip__") {
        console.error("err", e.shortMessage || e.message);
        if (e.stack) console.error(e.stack);
      }
      tunePoll(false);
    }
    await sleep(pollMs);
    
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
