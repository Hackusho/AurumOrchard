require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const norm = (a) => ethers.getAddress(a.toLowerCase());

  const exeAddr = process.env.FLASH_EXECUTOR_ADDRESS;
  if (!exeAddr) throw new Error("Set FLASH_EXECUTOR_ADDRESS in .env");

  // Tokens (USDC.e to match your contract constants)
  const WETH  = norm("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
  const USDCe = norm("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8");

  // Contracts
  const signer = new ethers.Wallet(process.env.SEED_KEY, ethers.provider);
  const exe    = await ethers.getContractAt("FlashloanExecutor", exeAddr, signer);

  // Amount
  const amount = BigInt(process.env.FLASH_AMOUNT_WEI || "10000000000000"); // 0.00001 WETH

  // --- quoting + params (choose best mid: USDC.e or native USDC) ---
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // UniV3 QuoterV2
const SUSHI  = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"; // Sushi V2 router
const IQuoter = new ethers.Interface([
  "function quoteExactInput(bytes path,uint256 amountIn) external returns (uint256 amountOut,uint160[] memory,uint32[] memory,uint256)"
]);
const ISushi = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn,address[] calldata path) external view returns (uint256[] memory amounts)"
]);
const quoter = new ethers.Contract(QUOTER, IQuoter, signer);
const sushi  = new ethers.Contract(SUSHI,  ISushi,  signer);

const USDC  = norm("0xAf88d065E77c8Cc2239327C5EDb3A432268e5831");

// fee must match your contract's UNISWAP_FEE (currently 3000)
const feeV3 = 3000;
const feeBytes = ethers.zeroPadValue(ethers.toBeHex(feeV3), 3);

// pick the best mid token by quote
const mids = [USDCe, USDC];
let mid = null, quoteA = 0n, quoteB = 0n;
for (const M of mids) {
  try {
    const packedPath = ethers.concat([WETH, feeBytes, M]);
    const [qa] = await quoter.quoteExactInput.staticCall(packedPath, amount); // WETH->M
    const amountsB = await sushi.getAmountsOut(qa, [M, WETH]);               // M->WETH
    const qb = amountsB[amountsB.length - 1];
    if (qb > quoteB) { mid = M; quoteA = qa; quoteB = qb; }
  } catch (_) {} // skip if route missing
}
if (!mid) { console.log("Skip: no Sushi route found for USDC.e or USDC"); return; }

// need = repay + gas + small safety (premium checked on-chain)
const feeData = await ethers.provider.getFeeData();
const gasWei  = (feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n) * 600000n;
const premPad = (amount * 7n) / 10000n;
const safety  = 10_000_000_000_000n;
const need    = amount + premPad + gasWei + safety;

if (quoteB < need) {
  console.log("Skip: not profitable now.", "quoteB:", quoteB.toString(), "need:", need.toString(), "mid:", mid);
  return;
}

// let routers fill; rely on on-chain profit guard
const minOutA = 0n, minOutB = 0n;
const minProfitWei = gasWei + premPad + safety;

const abi = ethers.AbiCoder.defaultAbiCoder();
const params = abi.encode(
  ["address[]","address[]","uint256","uint256","uint256"],
  [[WETH, mid], [mid, WETH], minOutA, minOutB, minProfitWei]
);

  console.log("owner :", (await exe.owner()).toLowerCase());
  console.log("caller:", (await signer.getAddress()).toLowerCase());

  await exe.runSimpleFlash.staticCall(WETH, amount, params);
  console.log("Static OK → sending tx…");

  const tx   = await exe.runSimpleFlash(WETH, amount, params, { gasLimit: 2_000_000 });
  const rcpt = await tx.wait();
  console.log({ hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString() });
}

main().catch((e) => { console.error(e); process.exit(1); });
