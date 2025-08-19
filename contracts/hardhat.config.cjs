require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// deploy:executor task
task("deploy:executor", "Deploys FlashloanExecutor")
  .addOptionalParam("provider", "Aave v3 PoolAddressesProvider")
  .addOptionalParam("goldstem", "Goldstem contract address")
  .addOptionalParam("root", "Root treasury EOA")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const provider = args.provider || process.env.AVE_POOL_ADDR_PROVIDER;
    const goldstem = args.goldstem || process.env.GOLDSTEM_ADDRESS;
    const root = args.root || process.env.ROOT_TREASURY;

    if (!provider || !goldstem || !root) {
      throw new Error("Missing provider/goldstem/root (pass --provider/--goldstem/--root or set env vars)");
    }

    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    console.log("Args:", { provider, goldstem, root });

    const Factory = await ethers.getContractFactory("FlashloanExecutor");
    const executor = await Factory.deploy(provider, goldstem, root);
    await executor.waitForDeployment();

    const deployedAddress = await executor.getAddress();
    console.log("FlashloanExecutor deployed to:", deployedAddress);
  });

// flash:dryrun task
task("flash:dryrun", "Executes a flashloan dry run")
  .addOptionalParam("executor", "FlashloanExecutor address")
  .addOptionalParam("asset", "ERC20 asset address to flash")
  .addOptionalParam("amount", "Amount in wei (or token units)")
  .addOptionalParam("root", "Root treasury/owner EOA")
  .setAction(async (args, hre) => {
    const { ethers } = hre;

    const addr = (x) => ethers.getAddress(x.toLowerCase());
    const executor = addr(args.executor || process.env.FLASH_EXECUTOR_ADDRESS);
    const asset = addr(args.asset || process.env.FLASH_ASSET);
    const amount = args.amount || process.env.FLASH_AMOUNT_WEI;
    const rootKey = args.root || process.env.ROOT_KEY;

    if (!executor || !asset || !amount || !rootKey) {
      throw new Error("Missing executor/asset/amount/rootKey (pass args or set env)");
    }

    const rootSigner = new ethers.Wallet(rootKey, ethers.provider);
    const flash = await ethers.getContractAt("FlashloanExecutor", executor, rootSigner);

    console.log("--- Flashloan Dry Run ---");
    console.log("Executor:", executor);
    console.log("Asset:", asset);
    console.log("Amount (wei):", amount);

    const token = await ethers.getContractAt("IERC20", asset);
    const rootTreasury = await flash.rootTreasury();
    const balBefore = await token.balanceOf(rootTreasury);

    const tx = await flash.runSimpleFlash(asset, amount, "0x");
    const rcpt = await tx.wait();
    console.log("Tx:", rcpt.transactionHash, "GasUsed:", rcpt.gasUsed.toString());

    const balAfter = await token.balanceOf(rootTreasury);
    console.log("Profit (wei):", balAfter - balBefore);

    for (const ev of rcpt.logs) {
      try {
        const parsed = flash.interface.parseLog(ev);
        if (parsed?.name === "FlashCompleted") {
          console.log("FlashCompleted -> premium:", parsed.args.premium.toString(),
            "profitWei:", parsed.args.profitWei.toString());
        }
      } catch { }
    }
  });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    arbitrumMainnet: {
      url: process.env.ARBITRUM_MAINNET_RPC_URL || "https://arb1.arbitrum.io/rpc",
      accounts: process.env.SEED_KEY ? [process.env.SEED_KEY] : [],
      chainId: 42161,
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      accounts: process.env.SEED_KEY ? [process.env.SEED_KEY] : [],
      chainId: 421614,
    },
    hardhat: {
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: {
      arbitrumMainnet: process.env.ARBISCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "arbitrumMainnet",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io/",
        },
      },
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io/",
        },
      },
    ],
  },
};
