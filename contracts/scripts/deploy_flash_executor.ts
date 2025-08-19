import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

async function main() {
    const hre = require("hardhat");
    const { AAVE_POOL_ADDR_PROVIDER, GOLDSTEM_ADDRESS, ROOT_KEY } = process.env;

    if (!AAVE_POOL_ADDR_PROVIDER || !GOLDSTEM_ADDRESS || !ROOT_KEY) {
        throw new Error("Missing required environment variables");
    }

    const rootSigner = new hre.ethers.Wallet(ROOT_KEY, hre.ethers.provider);
    const rootEoa = await rootSigner.getAddress();

    console.log("Deploying FlashloanExecutor...");
    const FlashloanExecutor = await hre.ethers.getContractFactory("FlashloanExecutor");
    const flashloanExecutor = await FlashloanExecutor.deploy(
        AAVE_POOL_ADDR_PROVIDER,
        GOLDSTEM_ADDRESS,
        rootEoa
    );

    await flashloanExecutor.waitForDeployment();

    const deployedAddress = await flashloanExecutor.getAddress();
    console.log("FlashloanExecutor deployed to:", deployedAddress);

    // --- Update .env file ---
    const envPath = path.join(__dirname, "../.env");
    let envFileContent = fs.readFileSync(envPath, "utf8");

    const key = "FLASH_EXECUTOR_ADDRESS";
    const regex = new RegExp(`^${key}=.*$`, "m");

    if (regex.test(envFileContent)) {
        envFileContent = envFileContent.replace(regex, `${key}=${flashloanExecutor.address}`);
    } else {
        envFileContent += `\n${key}=${flashloanExecutor.address}`;
    }

    fs.writeFileSync(envPath, envFileContent);
    console.log(`Updated ${key} in .env file`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
