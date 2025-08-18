require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const ARBITRUM_MAINNET_RPC_URL = process.env.ARBITRUM_MAINNET_RPC_URL || "";
const SEED_KEY = process.env.SEED_KEY || "";

task("flash:dryrun", "Executes a flashloan dry run")
    .setAction(async (taskArgs, hre) => {
        const { ethers } = hre;
        const { FLASH_EXECUTOR_ADDRESS, FLASH_ASSET, FLASH_AMOUNT_WEI, ROOT_KEY } = process.env;

        if (!FLASH_EXECUTOR_ADDRESS || !FLASH_ASSET || !FLASH_AMOUNT_WEI || !ROOT_KEY) {
            throw new Error("Missing required environment variables for flash:dryrun task");
        }

        const rootSigner = new ethers.Wallet(ROOT_KEY, ethers.provider);
        const flashloanExecutor = await ethers.getContractAt("FlashloanExecutor", FLASH_EXECUTOR_ADDRESS, rootSigner);

        console.log("--- Flashloan Dry Run ---");
        console.log("Executor Address:", flashloanExecutor.address);
        console.log("Flash Asset:", FLASH_ASSET);
        console.log("Flash Amount (wei):", FLASH_AMOUNT_WEI);

        const rootTreasury = await flashloanExecutor.rootTreasury();
        const token = await ethers.getContractAt("IERC20", FLASH_ASSET);
        const balanceBefore = await token.balanceOf(rootTreasury);

        const tx = await flashloanExecutor.runSimpleFlash(FLASH_ASSET, FLASH_AMOUNT_WEI, "0x");
        const receipt = await tx.wait();

        console.log("\nTransaction Details:");
        console.log("  Tx Hash:", receipt.transactionHash);
        console.log("  Gas Used:", receipt.gasUsed.toString());

        const balanceAfter = await token.balanceOf(rootTreasury);
        const profit = balanceAfter.sub(balanceBefore);

        console.log("\nResults:");
        console.log("  Profit (wei):", profit.toString());

        for (const event of receipt.events) {
            if (event.event === "FlashCompleted") {
                console.log("  FlashCompleted Event:");
                console.log("    Profit (wei):", event.args.profitWei.toString());
            }
        }
        console.log("-------------------------");
    });

// deploy:executor  
task("deploy:executor", "Deploys FlashloanExecutor")
  .addOptionalParam("provider", "Aave v3 PoolAddressesProvider")
  .addOptionalParam("goldstem", "Goldstem contract address")
  .addOptionalParam("root", "Root treasury EOA")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const provider = args.provider || process.env.AVE_POOL_ADDR_PROVIDER;
    const goldstem = args.goldstem || process.env.GOLDSTEM_ADDRESS;
    const root     = args.root     || process.env.ROOT_TREASURY;

    if (!provider || !goldstem || !root) {
      throw new Error("Missing provider/goldstem/root (pass --provider/--goldstem/--root or set env vars)");
    }

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Args:", { provider, goldstem, root });

    const Factory = await ethers.getContractFactory("FlashloanExecutor");
    const executor = await Factory.deploy(provider, goldstem, root);
    await executor.deployed();

    console.log("FlashloanExecutor deployed to:", executor.address);
  });

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    arbitrum: {
      url: ARBITRUM_MAINNET_RPC_URL,
      accounts: SEED_KEY ? [SEED_KEY] : [],
      chainId: 42161,
    },
  },
};
