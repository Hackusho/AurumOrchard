const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("FlashloanExecutor", function () {
  const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"; // Arbitrum PoolAddressesProvider
  const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  const SUSHI_V2_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

  async function deployExecutorFixture() {
    const [owner, goldstem, rootTreasury, otherAccount] = await ethers.getSigners();

    const FlashloanExecutorFactory = await ethers.getContractFactory("FlashloanExecutor");
    const executor = await FlashloanExecutorFactory.deploy(AAVE_PROVIDER, goldstem.address, rootTreasury.address);
    await executor.waitForDeployment();

    return { executor, owner, goldstem, rootTreasury, otherAccount };
  }

  describe("Deployment & Configuration", function () {
    it("Should set the correct owner", async function () {
      const { executor, owner } = await loadFixture(deployExecutorFixture);
      expect(await executor.owner()).to.equal(owner.address);
    });

    it("Should initialize with the correct addresses", async function () {
      const { executor, goldstem, rootTreasury } = await loadFixture(deployExecutorFixture);
      expect(await executor.provider()).to.equal(AAVE_PROVIDER);
      expect(await executor.goldstem()).to.equal(goldstem.address);
      expect(await executor.rootTreasury()).to.equal(rootTreasury.address);
      expect(await executor.uniswapV3Router()).to.equal(UNISWAP_V3_ROUTER);
      expect(await executor.sushiV2Router()).to.equal(SUSHI_V2_ROUTER);
    });

    it("Should allow the owner to set a new Goldstem address", async function () {
      const { executor, owner, otherAccount } = await loadFixture(deployExecutorFixture);
      await executor.connect(owner).setGoldstem(otherAccount.address);
      expect(await executor.goldstem()).to.equal(otherAccount.address);
    });

    it("Should not allow a non-owner to set a new Goldstem address", async function () {
      const { executor, otherAccount } = await loadFixture(deployExecutorFixture);
      await expect(executor.connect(otherAccount).setGoldstem(otherAccount.address)).to.be.revertedWithCustomError(
        executor,
        "OwnableUnauthorizedAccount"
      );
    });

    it("Should allow the owner to set new router addresses", async function () {
        const { executor, owner } = await loadFixture(deployExecutorFixture);
        const newUniV3 = ethers.Wallet.createRandom().address;
        const newSushiV2 = ethers.Wallet.createRandom().address;
        await executor.connect(owner).setRouters(newUniV3, newSushiV2);
        expect(await executor.uniswapV3Router()).to.equal(newUniV3);
        expect(await executor.sushiV2Router()).to.equal(newSushiV2);
    });

    it("Should not allow a non-owner to set new router addresses", async function () {
        const { executor, otherAccount } = await loadFixture(deployExecutorFixture);
        const newUniV3 = ethers.Wallet.createRandom().address;
        const newSushiV2 = ethers.Wallet.createRandom().address;
        await expect(executor.connect(otherAccount).setRouters(newUniV3, newSushiV2)).to.be.revertedWithCustomError(
            executor,
            "OwnableUnauthorizedAccount"
        );
    });
  });

  describe("Pausable", function () {
    it("Should allow the owner to pause and unpause", async function () {
        const { executor, owner } = await loadFixture(deployExecutorFixture);
        await executor.connect(owner).pause();
        expect(await executor.paused()).to.be.true;

        await executor.connect(owner).unpause();
        expect(await executor.paused()).to.be.false;
    });

    it("Should not allow a non-owner to pause or unpause", async function () {
        const { executor, otherAccount } = await loadFixture(deployExecutorFixture);
        await expect(executor.connect(otherAccount).pause()).to.be.revertedWithCustomError(
            executor,
            "OwnableUnauthorizedAccount"
        );
        await executor.pause(); // pause as owner first
        await expect(executor.connect(otherAccount).unpause()).to.be.revertedWithCustomError(
            executor,
            "OwnableUnauthorizedAccount"
        );
    });
  });
});
