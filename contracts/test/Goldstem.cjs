const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Goldstem", function () {
  let Goldstem, goldstem, owner, fruitWallet, branchesWallet, addr1;

  beforeEach(async function () {
    [owner, fruitWallet, branchesWallet, addr1] = await ethers.getSigners();

    const GoldstemFactory = await ethers.getContractFactory("Goldstem");
    goldstem = await GoldstemFactory.deploy(fruitWallet.address, branchesWallet.address);
    await goldstem.waitForDeployment();
  });

  it("Should set the right owner", async function () {
    expect(await goldstem.owner()).to.equal(owner.address);
  });

  it("Should set the right fruit and branches wallets", async function () {
    expect(await goldstem.fruitWallet()).to.equal(fruitWallet.address);
    expect(await goldstem.branchesWallet()).to.equal(branchesWallet.address);
  });

  it("Should split funds correctly", async function () {
    const initialFruitBalance = await ethers.provider.getBalance(fruitWallet.address);
    const initialBranchesBalance = await ethers.provider.getBalance(branchesWallet.address);

    const amountToSend = ethers.parseEther("10");
    await owner.sendTransaction({
      to: await goldstem.getAddress(),
      value: amountToSend,
    });

    const finalFruitBalance = await ethers.provider.getBalance(fruitWallet.address);
    const finalBranchesBalance = await ethers.provider.getBalance(branchesWallet.address);

    const fruitShare = await goldstem.fruitShare();
    const branchesShare = await goldstem.branchesShare();
    const fruitAmount = (amountToSend * fruitShare) / 100n;
    const branchesAmount = (amountToSend * branchesShare) / 100n;

    expect(finalFruitBalance - initialFruitBalance).to.equal(fruitAmount);
    expect(finalBranchesBalance - initialBranchesBalance).to.equal(branchesAmount);
  });

  it("Should allow owner to set new shares", async function () {
    await goldstem.connect(owner).setShares(30, 70);
    expect(await goldstem.fruitShare()).to.equal(30);
    expect(await goldstem.branchesShare()).to.equal(70);
  });

  it("Should not allow non-owner to set new shares", async function () {
    await expect(goldstem.connect(addr1).setShares(30, 70)).to.be.revertedWith(
      "Only owner can set shares"
    );
  });

  it("Should revert when shares do not add up to 100", async function () {
    await expect(goldstem.connect(owner).setShares(30, 80)).to.be.revertedWith(
      "Shares must add up to 100"
    );
  });

  it("Should allow owner to set new wallets", async function () {
    const newFruitWallet = addr1;
    const newBranchesWallet = owner;

    await goldstem.connect(owner).setWallets(newFruitWallet.address, newBranchesWallet.address);

    expect(await goldstem.fruitWallet()).to.equal(newFruitWallet.address);
    expect(await goldstem.branchesWallet()).to.equal(newBranchesWallet.address);
  });

  it("Should not allow non-owner to set new wallets", async function () {
    const newFruitWallet = addr1;
    const newBranchesWallet = owner;

    await expect(
      goldstem.connect(addr1).setWallets(newFruitWallet.address, newBranchesWallet.address)
    ).to.be.revertedWith("Only owner can set wallets");
  });

  it("Should allow owner to withdraw funds", async function () {
    // Send some funds to the contract first
    const amountToSend = ethers.parseEther("1");
    await addr1.sendTransaction({ to: await goldstem.getAddress(), value: amountToSend });

    const contractBalanceBefore = await ethers.provider.getBalance(await goldstem.getAddress());
    const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

    const tx = await goldstem.connect(owner).withdraw();
    const receipt = await tx.wait();
    const gasUsed = receipt.gasUsed * tx.gasPrice;

    const contractBalanceAfter = await ethers.provider.getBalance(await goldstem.getAddress());
    const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);

    expect(contractBalanceAfter).to.equal(0);
    expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + contractBalanceBefore - gasUsed);
  });

  it("Should not allow non-owner to withdraw funds", async function () {
    await expect(goldstem.connect(addr1).withdraw()).to.be.revertedWith(
      "Only owner can withdraw"
    );
  });
});
