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
    const root     = args.root     || process.env.ROOT_TREASURY;

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
task("flash:dryrun", "Simulates flash loan execution without actually calling the blockchain")
  .addParam("executor", "FlashloanExecutor contract address")
  .addParam("asset", "Token address to flash loan")
  .addParam("amount", "Amount to flash loan (in wei)")
  .addOptionalParam("provider", "Aave v3 PoolAddressesProvider")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const executor = args.executor;
    const asset = args.asset;
    const amount = args.amount;
    const provider = args.provider || process.env.AVE_POOL_ADDR_PROVIDER;

    if (!provider) {
      throw new Error("Missing provider (pass --provider or set AVE_POOL_ADDR_PROVIDER env var)");
    }

    console.log("=== Flash Loan Dry Run ===");
    console.log("Executor:", executor);
    console.log("Asset:", asset);
    console.log("Amount:", amount);
    console.log("Provider:", provider);

    // Get contract instances
    const executorContract = await ethers.getContractAt("FlashloanExecutor", executor);
    const assetContract = await ethers.getContractAt("IERC20", asset);
    const poolProvider = await ethers.getContractAt("IPoolAddressesProvider", provider);

    try {
      // Get pool address
      const poolAddress = await poolProvider.getPool();
      console.log("Pool Address:", poolAddress);

      // Check if executor is paused
      const isPaused = await executorContract.paused();
      console.log("Executor Paused:", isPaused);

      if (isPaused) {
        console.log("❌ Executor is paused - cannot execute flash loan");
        return;
      }

      // Check asset balance (this would be 0 in a real scenario before flash loan)
      const balance = await assetContract.balanceOf(executor);
      console.log("Current Asset Balance:", balance.toString());

      // Simulate the flash loan logic
      console.log("\n=== Simulating Flash Loan Execution ===");
      
      // Calculate premium (typically 0.05% for Aave v3)
      const premium = (BigInt(amount) * BigInt(5)) / BigInt(10000); // 0.05%
      const repayAmount = BigInt(amount) + premium;
      
      console.log("Flash Loan Amount:", amount);
      console.log("Premium (0.05%):", premium.toString());
      console.log("Repay Amount:", repayAmount.toString());

      // Check if executor has enough balance to repay (in real scenario, this would come from arbitrage)
      if (balance >= repayAmount) {
        const profit = balance - repayAmount;
        console.log("✅ Flash loan would succeed");
        console.log("Profit:", profit.toString());
      } else {
        console.log("❌ Flash loan would fail - insufficient balance to repay");
        console.log("Required:", repayAmount.toString());
        console.log("Available:", balance.toString());
      }

      console.log("\n=== Dry Run Complete ===");
      console.log("Note: This is a simulation. No actual transactions were sent.");

    } catch (error) {
      console.error("Error during dry run:", error.message);
    }
  });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
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
