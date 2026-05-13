import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers, type JsonRpcSigner } from "ethers";
import { network } from "hardhat";
import hre from "hardhat";

const UNIT = 10n ** 6n; // USDC 6 decimals
const toUSDC = (n: number) => BigInt(n) * UNIT;

// buckets [25,28,31,34] → 5 區間
// 0: ≤25 | 1: 25~28 | 2: 28~31 | 3: 31~34 | 4: >34
const BUCKETS = [25n, 28n, 31n, 34n];

describe("WeatherMarket", async function () {
  // 建立一個共用的 network 連線（Hardhat v3 EDR）
  const conn = await network.create();
  const { networkHelpers } = conn;
  const provider = new ethers.BrowserProvider(conn.provider as any);

  // ── fixture：部署合約、mint USDC、建立市場 ──────────────────────────────
  async function deployContracts(_conn: unknown) {
    const accounts = await provider.listAccounts() as JsonRpcSigner[];
    const [owner, alice, bob, oracleSigner] = accounts;

    // MockUSDC
    const usdcArt = await hre.artifacts.readArtifact("MockUSDC");
    const mockUSDC = await new ethers.ContractFactory(
      usdcArt.abi,
      usdcArt.bytecode,
      owner,
    ).deploy();
    await mockUSDC.waitForDeployment();
    const usdcAddr = await mockUSDC.getAddress();

    // WeatherMarket
    const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
    const weatherMarket = await new ethers.ContractFactory(
      wmArt.abi,
      wmArt.bytecode,
      owner,
    ).deploy(usdcAddr, oracleSigner.address);
    await weatherMarket.waitForDeployment();
    const wmAddr = await weatherMarket.getAddress();

    // mint + approve
    await (mockUSDC.connect(owner) as any).mint(alice.address, toUSDC(1000));
    await (mockUSDC.connect(owner) as any).mint(bob.address, toUSDC(1000));
    await (mockUSDC.connect(alice) as any).approve(wmAddr, toUSDC(1000));
    await (mockUSDC.connect(bob) as any).approve(wmAddr, toUSDC(1000));

    const latestBlock = (await provider.getBlock("latest"))!;
    const now = Number(latestBlock.timestamp);
    const lockTime = now + 3600;   // +1 小時後鎖盤
    const targetDate = now + 7200; // +2 小時後公布結果

    await (weatherMarket.connect(owner) as any).createMarket(
      "Taipei",
      targetDate,
      BUCKETS,
      lockTime,
    );

    return {
      owner,
      alice,
      bob,
      oracleSigner,
      mockUSDC,
      weatherMarket,
      marketId: 0n,
      lockTime,
    };
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  it("happy path: bet → lock → settle → claim winnings", async () => {
    const {
      owner,
      alice,
      bob,
      oracleSigner,
      mockUSDC,
      weatherMarket,
      marketId,
      lockTime,
    } = await networkHelpers.loadFixture(deployContracts);

    // Alice 押 bucket 2 (28~31°C)，Bob 押 bucket 3 (31~34°C)
    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(100));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 3, toUSDC(50));

    // 推進時間超過 lockTime
    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);

    // oracle 提交 30°C → bucket 2 wins
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 30n);

    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;

    // totalPool=150, fee 2%=3, netPool=147 → Alice 拿走 147 USDC
    assert.equal(alicePayout, toUSDC(147));

    const fees = await (weatherMarket as any).collectedFees();
    assert.equal(fees, toUSDC(3));

    // owner 提領手續費
    const ownerBefore = await (mockUSDC as any).balanceOf(owner.address);
    await (weatherMarket.connect(owner) as any).withdrawFees();
    const ownerGot = (await (mockUSDC as any).balanceOf(owner.address)) - ownerBefore;
    assert.equal(ownerGot, toUSDC(3));
  });

  it("multiple winners split pool proportionally", async () => {
    const { alice, bob, oracleSigner, mockUSDC, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    // 兩人都押 bucket 2，100 + 100 = 200 USDC
    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(100));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 2, toUSDC(100));

    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 30n);

    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    const bobBefore = await (mockUSDC as any).balanceOf(bob.address);
    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    await (weatherMarket.connect(bob) as any).claimWinnings(marketId);

    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;
    const bobPayout = (await (mockUSDC as any).balanceOf(bob.address)) - bobBefore;

    // netPool = 196，各拿 98 USDC
    assert.equal(alicePayout, toUSDC(98));
    assert.equal(bobPayout, toUSDC(98));
  });

  // ── No-winner 退款 ─────────────────────────────────────────────────────────

  it("no winner: refunds all bets in full", async () => {
    const { alice, bob, oracleSigner, mockUSDC, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    // 兩人都押 bucket 0，但溫度 >34 → bucket 4 wins（無人押注）
    await (weatherMarket.connect(alice) as any).placeBet(marketId, 0, toUSDC(100));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 0, toUSDC(50));

    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 35n);

    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    const bobBefore = await (mockUSDC as any).balanceOf(bob.address);
    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    await (weatherMarket.connect(bob) as any).claimWinnings(marketId);

    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;
    const bobPayout = (await (mockUSDC as any).balanceOf(bob.address)) - bobBefore;

    // 無手續費，全額退款
    assert.equal(alicePayout, toUSDC(100));
    assert.equal(bobPayout, toUSDC(50));
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("revert: claimWinnings before market is settled", async () => {
    const { alice, weatherMarket, marketId } =
      await networkHelpers.loadFixture(deployContracts);

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(10));

    await assert.rejects(
      (weatherMarket.connect(alice) as any).claimWinnings(marketId),
      /not settled/,
    );
  });

  it("revert: double claim", async () => {
    const { alice, bob, oracleSigner, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(100));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 3, toUSDC(50));
    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 30n);

    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);

    await assert.rejects(
      (weatherMarket.connect(alice) as any).claimWinnings(marketId),
      /already claimed/,
    );
  });

  it("revert: non-oracle calling submitResult", async () => {
    const { alice, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(10));
    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);

    await assert.rejects(
      (weatherMarket.connect(alice) as any).submitResult(marketId, 30n),
      /not oracle/,
    );
  });

  it("revert: placeBet after lock time", async () => {
    const { alice, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    await networkHelpers.time.increaseTo(lockTime + 1);

    await assert.rejects(
      (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(10)),
      /past lock time/,
    );
  });

  it("revert: lockMarket before lock time", async () => {
    const { alice, weatherMarket, marketId } =
      await networkHelpers.loadFixture(deployContracts);

    await assert.rejects(
      (weatherMarket.connect(alice) as any).lockMarket(marketId),
      /lock time not reached/,
    );
  });

  it("revert: submitResult on non-locked market", async () => {
    const { oracleSigner, weatherMarket, marketId } =
      await networkHelpers.loadFixture(deployContracts);

    await assert.rejects(
      (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 30n),
      /not locked/,
    );
  });

  // ── AdminOracle 整合 ───────────────────────────────────────────────────────

  it("AdminOracle: owner submits result, WeatherMarket settles correctly", async () => {
    const {
      owner,
      alice,
      bob,
      oracleSigner,
      mockUSDC,
      weatherMarket,
      marketId,
      lockTime,
    } = await networkHelpers.loadFixture(deployContracts);

    // 部署 AdminOracle，指向 WeatherMarket
    const aoArt = await hre.artifacts.readArtifact("AdminOracle");
    const adminOracle = await new ethers.ContractFactory(
      aoArt.abi,
      aoArt.bytecode,
      owner,
    ).deploy(await weatherMarket.getAddress());
    await adminOracle.waitForDeployment();

    // 把 WeatherMarket oracle 換成 AdminOracle
    await (weatherMarket.connect(owner) as any).setOracle(
      await adminOracle.getAddress(),
    );

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(100));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 3, toUSDC(50));
    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);

    // 透過 AdminOracle (onlyOwner) 提交結果
    await (adminOracle.connect(owner) as any).submitResult("Taipei", 30n, marketId);

    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;

    assert.equal(alicePayout, toUSDC(147));
  });
});
