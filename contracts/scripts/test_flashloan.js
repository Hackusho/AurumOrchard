const { ethers } = require("hardhat");

async function main() {
  console.log("=== Flash Loan Test Script ===");
  
  // Configuration - update these values
  const EXECUTOR_ADDRESS = process.env.FLASH_EXECUTOR_ADDRESS;
  const ASSET_ADDRESS = process.env.TEST_ASSET_ADDRESS || "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // WETH on Arbitrum
  const FLASH_AMOUNT = ethers.parseEther("1"); // 1 WETH
  const PROVIDER_ADDRESS = process.env.AVE_POOL_ADDR_PROVIDER;

  if (!EXECUTOR_ADDRESS) {
    throw new Error("Please set FLASH_EXECUTOR_ADDRESS in your .env file");
  }

  if (!PROVIDER_ADDRESS) {
    throw new Error("Please set AVE_POOL_ADDR_PROVIDER in your .env file");
  }

  console.log("Executor Address:", EXECUTOR_ADDRESS);
  console.log("Asset Address:", ASSET_ADDRESS);
  console.log("Flash Amount:", ethers.formatEther(FLASH_AMOUNT), "tokens");
  console.log("Provider Address:", PROVIDER_ADDRESS);

  // Get signer
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);

  // Get contract instances
  const executor = await ethers.getContractAt("FlashloanExecutor", EXECUTOR_ADDRESS);
  const asset = await ethers.getContractAt("IERC20", ASSET_ADDRESS);
  const provider = await ethers.getContractAt("IPoolAddressesProvider", PROVIDER_ADDRESS);

  try {
    // Check if executor is paused
    const isPaused = await executor.paused();
    console.log("Executor Paused:", isPaused);

    if (isPaused) {
      console.log("❌ Executor is paused - cannot execute flash loan");
      return;
    }

    // Check if signer is owner
    const owner = await executor.owner();
    console.log("Executor Owner:", owner);
    
    if (owner !== signer.address) {
      console.log("❌ Signer is not the owner - cannot execute flash loan");
      return;
    }

    // Get pool address
    const poolAddress = await provider.getPool();
    console.log("Pool Address:", poolAddress);

    // Check current balance
    const balanceBefore = await asset.balanceOf(EXECUTOR_ADDRESS);
    console.log("Balance Before Flash Loan:", ethers.formatEther(balanceBefore), "tokens");

    // Check if we have enough balance to cover the premium
    const premium = (FLASH_AMOUNT * BigInt(5)) / BigInt(10000); // 0.05%
    console.log("Flash Loan Premium:", ethers.formatEther(premium), "tokens");

    if (balanceBefore < premium) {
      console.log("❌ Insufficient balance to cover premium");
      console.log("Required:", ethers.formatEther(premium), "tokens");
      console.log("Available:", ethers.formatEther(balanceBefore), "tokens");
      return;
    }

    console.log("\n=== Executing Flash Loan ===");
    
    // Execute flash loan
    const tx = await executor.runSimpleFlash(ASSET_ADDRESS, FLASH_AMOUNT, "0x");
    console.log("Transaction Hash:", tx.hash);
    
    // Wait for confirmation
    const receipt = await tx.wait();
    console.log("Transaction confirmed in block:", receipt.blockNumber);

    // Check balance after
    const balanceAfter = await asset.balanceOf(EXECUTOR_ADDRESS);
    console.log("Balance After Flash Loan:", ethers.formatEther(balanceAfter), "tokens");

    // Check for profit
    if (balanceAfter > balanceBefore) {
      const profit = balanceAfter - balanceBefore;
      console.log("✅ Flash loan executed successfully!");
      console.log("Profit:", ethers.formatEther(profit), "tokens");
    } else {
      console.log("⚠️ Flash loan executed but no profit generated");
    }

  } catch (error) {
    console.error("Error executing flash loan:", error.message);
    
    // Check if it's a revert error
    if (error.data) {
      console.log("Revert data:", error.data);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
