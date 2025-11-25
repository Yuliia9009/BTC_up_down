import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const PRICE_SCALE = 10n ** 8n;

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const MockOracle = await ethers.getContractFactory("MockOracle");
  const oracle = await MockOracle.deploy();
  await oracle.waitForDeployment();
  await oracle.setAnswer(60000n * PRICE_SCALE);

  const BtcUpDown = await ethers.getContractFactory("BtcUpDown");
  const game = await BtcUpDown.deploy(await oracle.getAddress());
  await game.waitForDeployment();

  return { game, oracle, owner, alice, bob };
}

describe("BtcUpDown", () => {
  describe("Winning scenario", () => {
    it("pays the winning side and accrues the fee", async () => {
      const { game, oracle, alice, bob } = await loadFixture(deployFixture);
      const roundId = await game.currentRoundId();

      const upStake = ethers.parseEther("1");
      const downStake = ethers.parseEther("2");

      await game.connect(alice).deposit({ value: upStake });
      await game.connect(bob).deposit({ value: downStake });

      await game.connect(alice).bet(0, upStake);
      await game.connect(bob).bet(1, downStake);

      const round = await game.getRound(roundId);

      await time.increaseTo(Number(round.lockTime));
      await oracle.setAnswer(60000n * PRICE_SCALE);
      await game.progress(); // lock

      await time.increaseTo(Number(round.settleTime));
      await oracle.setAnswer(65000n * PRICE_SCALE);
      await game.progress(); // settle

      const pool = upStake + downStake;
      const expectedFee = (pool * 100n) / 10000n;
      const expectedReward = pool - expectedFee;

      await game.connect(alice).claim(roundId);
      expect(await game.balance(alice.address)).to.equal(expectedReward);

      expect(await game.feesAccrued()).to.equal(expectedFee);
      expect(await game.winsCount(alice.address)).to.equal(1n);

      await expect(game.connect(bob).claim(roundId)).to.be.revertedWith("NO_WIN");
    });
  });

  describe("Refund scenario", () => {
    it("refunds every bettor when settle price equals lock price", async () => {
      const { game, oracle, alice, bob } = await loadFixture(deployFixture);
      const roundId = await game.currentRoundId();

      const upStake = ethers.parseEther("0.5");
      const downStake = ethers.parseEther("0.8");

      await game.connect(alice).deposit({ value: upStake });
      await game.connect(bob).deposit({ value: downStake });
      await game.connect(alice).bet(0, upStake);
      await game.connect(bob).bet(1, downStake);

      const round = await game.getRound(roundId);

      await time.increaseTo(Number(round.lockTime));
      await oracle.setAnswer(70000n * PRICE_SCALE);
      await game.progress(); // lock

      await time.increaseTo(Number(round.settleTime));
      await oracle.setAnswer(70000n * PRICE_SCALE); // no price change
      await game.progress(); // settle with refund

      await game.connect(alice).claim(roundId);
      await game.connect(bob).claim(roundId);
      expect(await game.balance(alice.address)).to.equal(upStake);
      expect(await game.balance(bob.address)).to.equal(downStake);

      expect(await game.feesAccrued()).to.equal(0n);
    });
  });
});
