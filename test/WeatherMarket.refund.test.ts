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

describe("WeatherMarket — no-winner refund & fee logic", async function () {
  const conn = await network.create();
  const { networkHelpers } = conn;
  const provider = new ethers.BrowserProvider(conn.provider as any);

  async function deployContracts(_conn: unknown) {
    const accounts = (await provider.listAccounts()) as JsonRpcSigner[];
    const [owner, alice, bob, oracleSigner] = accounts;

    const usdcArt = await hre.artifacts.readArtifact("MockUSDC");
    const mockUSDC = await new ethers.ContractFactory(
      usdcArt.abi,
      usdcArt.bytecode,
      owner,
    ).deploy();
    await mockUSDC.waitForDeployment();
    const usdcAddr = await mockUSDC.getAddress();

    const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
    const weatherMarket = await new ethers.ContractFactory(
      wmArt.abi,
      wmArt.bytecode,
      owner,
    ).deploy(usdcAddr, oracleSigner.address);
    await weatherMarket.waitForDeployment();
    const wmAddr = await weatherMarket.getAddress();

    await (mockUSDC.connect(owner) as any).mint(alice.address, toUSDC(1000));
    await (mockUSDC.connect(owner) as any).mint(bob.address, toUSDC(1000));
    await (mockUSDC.connect(alice) as any).approve(wmAddr, toUSDC(1000));
    await (mockUSDC.connect(bob) as any).approve(wmAddr, toUSDC(1000));

    const latestBlock = (await provider.getBlock("latest"))!;
    const now = Number(latestBlock.timestamp);
    const lockTime = now + 3600;
    const targetDate = now + 7200;

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

  // ── Test 1 ────────────────────────────────────────────────────────────────
  // Alice 押 bucket 0，Bob 押 bucket 1，temp=35 → bucket 4 獲勝（無人押注）
  // → noWinner=true，各自全額退款，無手續費

  it("test: refunds all bets when no winner", async () => {
    const { alice, bob, oracleSigner, mockUSDC, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 0, toUSDC(1));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 1, toUSDC(1));

    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);

    // temp=35 → _determineWinningBucket([25,28,31,34], 35) = bucket 4（>34），無人押注
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 35n);

    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    const bobBefore = await (mockUSDC as any).balanceOf(bob.address);

    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    await (weatherMarket.connect(bob) as any).claimWinnings(marketId);

    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;
    const bobPayout = (await (mockUSDC as any).balanceOf(bob.address)) - bobBefore;

    // 無手續費，原額退款
    assert.equal(alicePayout, toUSDC(1));
    assert.equal(bobPayout, toUSDC(1));
  });

  // ── Test 2 ────────────────────────────────────────────────────────────────
  // 同上流程，驗證合約 USDC 餘額及 collectedFees 在全員 claim 後為 0

  it("test: fee is waived when no winner", async () => {
    const { alice, bob, oracleSigner, mockUSDC, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    await (weatherMarket.connect(alice) as any).placeBet(marketId, 0, toUSDC(1));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 1, toUSDC(1));

    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 35n);

    await (weatherMarket.connect(alice) as any).claimWinnings(marketId);
    await (weatherMarket.connect(bob) as any).claimWinnings(marketId);

    const wmAddr = await weatherMarket.getAddress();
    const contractBalance = await (mockUSDC as any).balanceOf(wmAddr);
    const collectedFees = await (weatherMarket as any).collectedFees();

    // 無贏家：手續費不收取，合約 USDC 清零
    assert.equal(contractBalance, 0n);
    assert.equal(collectedFees, 0n);
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  // Alice 押 bucket 2（28~31°C），Bob 押 bucket 3（31~34°C），temp=30 → bucket 2 獲勝
  // 贏家（Alice）領回 1.96 USDC（pool 2 USDC - 2% fee）
  // 輸家（Bob）claimWinnings 應 revert

  it("test: winner takes pool minus fee", async () => {
    const { alice, bob, oracleSigner, mockUSDC, weatherMarket, marketId, lockTime } =
      await networkHelpers.loadFixture(deployContracts);

    // Alice 押 bucket 2，Bob 押 bucket 3，各 1 USDC
    await (weatherMarket.connect(alice) as any).placeBet(marketId, 2, toUSDC(1));
    await (weatherMarket.connect(bob) as any).placeBet(marketId, 3, toUSDC(1));

    await networkHelpers.time.increaseTo(lockTime + 1);
    await (weatherMarket.connect(alice) as any).lockMarket(marketId);

    // temp=30 → _determineWinningBucket([25,28,31,34], 30) = bucket 2（28<30≤31）
    await (weatherMarket.connect(oracleSigner) as any).submitResult(marketId, 30n);

    // 驗證 Alice 贏家領回：totalPool=2, fee=2*2%=0.04, netPool=1.96 USDC
    // 注意：Hardhat EDR 對小額 winner path 的 gas estimation 偏低，用 populateTransaction 繞過
    const aliceBefore = await (mockUSDC as any).balanceOf(alice.address);
    const aliceTx = await (weatherMarket.connect(alice) as any).claimWinnings.populateTransaction(marketId);
    aliceTx.gasLimit = 300_000n;
    await (await alice.sendTransaction(aliceTx)).wait();
    const alicePayout = (await (mockUSDC as any).balanceOf(alice.address)) - aliceBefore;
    assert.equal(alicePayout, 1_960_000n); // 1.96 USDC

    // 驗證 Bob 輸家 claimWinnings revert
    // staticCall = eth_call，不需 gas estimation，可正確捕捉 revert reason
    await assert.rejects(
      (weatherMarket.connect(bob) as any).claimWinnings.staticCall(marketId),
      /no winning bet/,
    );
  });
});
