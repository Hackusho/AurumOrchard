require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const norm = (a) => hre.ethers.getAddress(a.toLowerCase());
  const exeAddr = process.env.FLASH_EXECUTOR_ADDRESS;
  const WETH  = norm("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
  const USDCe = norm("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8");

  const signer = new hre.ethers.Wallet(process.env.SEED_KEY, hre.ethers.provider);
  const exe = await hre.ethers.getContractAt("FlashloanExecutor", exeAddr, signer);

  const amount = BigInt(process.env.FLASH_AMOUNT_WEI || "10000000000000");
  const pathA = [WETH, USDCe], pathB = [USDCe, WETH];

  const fee = await hre.ethers.provider.getFeeData();
  const price = (fee.gasPrice ?? fee.maxFeePerGas ?? 0n);
  const gasWei = price * 600000n, premiumPad = (amount * 7n) / 10000n, safety = 10_000_000_000_000n;
  const minProfitWei = gasWei + premiumPad + safety, minOutA = 0n, minOutB = amount + premiumPad + minProfitWei;

  const abi = hre.ethers.AbiCoder.defaultAbiCoder();
  const params = abi.encode(["address[]","address[]","uint256","uint256","uint256"], [pathA, pathB, minOutA, minOutB, minProfitWei]);

  await exe.runSimpleFlash.staticCall(WETH, amount, params);
  const tx = await exe.runSimpleFlash(WETH, amount, params, { gasLimit: 2_000_000 });
  const rcpt = await tx.wait();
  console.log({ hash: rcpt.transactionHash, gasUsed: rcpt.gasUsed.toString() });
}

main().catch((e) => { console.error(e); process.exit(1); });
