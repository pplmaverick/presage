import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers, type JsonRpcSigner } from "ethers";
import { network } from "hardhat";
import hre from "hardhat";

// Dedicated checks for INV-1 through INV-4.
// The IRM suite covers "are the computed numbers right"; this one covers "do the
// invariants hold under hostile and boundary inputs".

const UNIT = 10n ** 6n;
const toUSDC = (n: number) => BigInt(n) * UNIT;
const BUCKETS = [25n, 28n, 31n, 34n];
const DAY = 24 * 60 * 60;

describe("WeatherMarket — invariants INV-1..INV-4", async function () {
  const conn = await network.create();
  const { networkHelpers } = conn;
  const provider = new ethers.BrowserProvider(conn.provider as any);
  const rawProvider = conn.provider as { request: (a: unknown) => Promise<any> };

  async function head(): Promise<number> {
    const b = await rawProvider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    return Number(BigInt(b.timestamp));
  }

  async function deploy(tokenContract = "MockUSDC") {
    const accounts = (await provider.listAccounts()) as JsonRpcSigner[];
    const [owner, alice, bob, carol, oracleSigner] = accounts;

    const tArt = await hre.artifacts.readArtifact(tokenContract);
    const token = await new ethers.ContractFactory(
      tArt.abi, tArt.bytecode, owner,
    ).deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
    const wm = await new ethers.ContractFactory(
      wmArt.abi, wmArt.bytecode, owner,
    ).deploy(tokenAddr, oracleSigner.address);
    await wm.waitForDeployment();
    const wmAddr = await wm.getAddress();

    for (const u of [alice, bob, carol]) {
      await (token.connect(owner) as any).mint(u.address, toUSDC(10_000));
      await (token.connect(u) as any).approve(wmAddr, toUSDC(10_000));
    }
    return { owner, alice, bob, carol, oracleSigner, token, tokenAddr, wm, wmAddr };
  }

  async function newMarket(wm: any, owner: JsonRpcSigner, offset = 0) {
    const now = await head();
    const lockTime = now + 3600 + offset;
    await (wm.connect(owner) as any).createMarket("Taipei", now + 7200 + offset, BUCKETS, lockTime);
    return lockTime;
  }

  // ── INV-4 ────────────────────────────────────────────────────────────────

  it("INV-4: reentering placeBet from transferFrom is blocked by nonReentrant", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy("ReentrantUSDC");
    await newMarket(wm, owner);

    // Make the token call back into placeBet during transferFrom
    await (token as any).arm(wmAddr, 0n, 2, toUSDC(1));

    await assert.rejects(
      (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100)),
      "the reentrant placeBet was not blocked",
    );

    // The whole transaction reverts; neither the books nor the balance should show a trace
    assert.equal(await (token as any).balanceOf(wmAddr), 0n);
    assert.equal((await (wm as any).getMarket(0n))[4], 0n);
    assert.equal(await (wm as any).bucketTotals(0n, 2), 0n);
  });

  it("INV-4: a fee-on-transfer token makes placeBet revert entirely (no overstated books)", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy("FeeOnTransferUSDC");
    await newMarket(wm, owner);

    await assert.rejects(
      (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100)),
      "fee-on-transfer was not caught by the received == amount check",
    );
    assert.equal(await (token as any).balanceOf(wmAddr), 0n);
    assert.equal((await (wm as any).getMarket(0n))[4], 0n);
  });

  it("INV-4: with a normal ERC20, placeBet books exactly what it received", async () => {
    const { owner, alice, bob, wm, wmAddr, token } = await deploy();
    await newMarket(wm, owner);

    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await (wm.connect(bob) as any).placeBet(0n, 3, toUSDC(37));

    const totalPool = (await (wm as any).getMarket(0n))[4] as bigint;
    assert.equal(totalPool, toUSDC(137));
    assert.equal(await (token as any).balanceOf(wmAddr), totalPool);
    assert.equal(await (wm as any).userTotalBets(0n, alice.address), toUSDC(100));
    assert.equal(await (wm as any).bucketTotals(0n, 2), toUSDC(100));
  });

  // ── INV-2 ────────────────────────────────────────────────────────────────

  it("INV-2: lockMarket always reverts for marketId >= nextMarketId", async () => {
    const { owner, alice, wm } = await deploy();
    const lockTime = await newMarket(wm, owner);
    assert.equal(await (wm as any).nextMarketId(), 1n);

    await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
    for (const bad of [1n, 2n, 999n, 2n ** 64n]) {
      await assert.rejects(
        (wm.connect(alice) as any).lockMarket(bad),
        `lockMarket(${bad}) should revert`,
      );
    }
    // An existing market still locks normally
    await (wm.connect(alice) as any).lockMarket(0n);
    assert.equal((await (wm as any).getMarket(0n))[3], 1n);
  });

  // ── INV-1 ────────────────────────────────────────────────────────────────

  it("INV-1: past the deadline claimRefund opens and the settlement window closes (mutually exclusive)", async () => {
    const { owner, alice, bob, oracleSigner, wm, wmAddr, token } = await deploy();
    const lockTime = await newMarket(wm, owner);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await (wm.connect(bob) as any).placeBet(0n, 3, toUSDC(50));

    await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
    await (wm.connect(alice) as any).lockMarket(0n);

    const timeout = Number(await (wm as any).marketLockedTimeout(0n));
    assert.equal(timeout, 3 * DAY, "should fall back to defaultLockedTimeout (3 days) when unspecified");
    const deadline = lockTime + timeout;
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(deadline));

    // increaseTo is used here to actually advance the chain head rather than
    // setNextBlockTimestamp: ethers runs eth_estimateGas before sending, and an
    // estimateGas that reverts clears the setNextBlockTimestamp override, which lands
    // the following transaction back at the old time. The exact per-second boundaries
    // (deadline-1 / deadline / deadline+1) are covered by the IRM suite.

    // Inside the window: refunds are not allowed (the next tx lands at deadline - 1)
    await networkHelpers.time.increaseTo(deadline - 2);
    await assert.rejects((wm.connect(alice) as any).claimRefund(0n));

    // After the window closes: settlement is impossible, only refunds (next tx lands at deadline + 1)
    await networkHelpers.time.increaseTo(deadline);
    await assert.rejects(
      (wm.connect(oracleSigner) as any).submitResult(0n, 30n),
      "submitResult should revert once the settlement window has closed",
    );

    // An explicit gasLimit is passed to skip ethers' eth_estimateGas. After the
    // preceding reverting estimateGas calls, EDR simulates with a timestamp older than
    // the chain head, so this transaction — which should succeed — is misjudged as a
    // revert during estimation. The execution itself is correct (the amount assertions
    // below verify it).
    const aliceBefore = (await (token as any).balanceOf(alice.address)) as bigint;
    await (wm.connect(alice) as any).claimRefund(0n, { gasLimit: 200_000 });
    assert.equal(
      ((await (token as any).balanceOf(alice.address)) as bigint) - aliceBefore,
      toUSDC(100),
      "the refund should be the full principal with no fee deducted",
    );

    // A second refund must be rejected
    await assert.rejects((wm.connect(alice) as any).claimRefund(0n));

    await (wm.connect(bob) as any).claimRefund(0n);
    assert.equal(await (token as any).balanceOf(wmAddr), 0n, "the contract should be drained once everyone has refunded");
    assert.equal(await (wm as any).collectedFees(), 0n, "the refund path must not accrue any fee");
  });

  it("INV-1: a SETTLED market cannot use claimRefund", async () => {
    const { owner, alice, oracleSigner, wm } = await deploy();
    const lockTime = await newMarket(wm, owner);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
    await (wm.connect(alice) as any).lockMarket(0n);
    await (wm.connect(oracleSigner) as any).submitResult(0n, 30n);

    const timeout = Number(await (wm as any).marketLockedTimeout(0n));
    await networkHelpers.time.increaseTo(lockTime + timeout + 10);
    await assert.rejects(
      (wm.connect(alice) as any).claimRefund(0n),
      "a SETTLED market should not be refundable",
    );
    // Normal claiming still works
    await (wm.connect(alice) as any).claimWinnings(0n);
    await assert.rejects((wm.connect(alice) as any).claimWinnings(0n));
  });

  // ── INV-3 ────────────────────────────────────────────────────────────────

  it("INV-3: across multiple markets with partial claims, collectedFees + unclaimed liability <= balance", async () => {
    const { owner, alice, bob, carol, oracleSigner, wm, wmAddr, token } = await deploy();

    // Market 0: has a winner; alice/bob bet the same bucket, carol bets a losing one
    const lock0 = await newMarket(wm, owner, 0);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await (wm.connect(bob) as any).placeBet(0n, 2, toUSDC(33));
    await (wm.connect(carol) as any).placeBet(0n, 0, toUSDC(7));

    // Market 1: nobody picked the winning bucket -> full refunds
    const lock1 = await newMarket(wm, owner, 60);
    await (wm.connect(alice) as any).placeBet(1n, 0, toUSDC(11));
    await (wm.connect(bob) as any).placeBet(1n, 1, toUSDC(13));

    // Market 2: locked but never settled -> exercises the INV-1 refund path
    const lock2 = await newMarket(wm, owner, 120);
    await (wm.connect(carol) as any).placeBet(2n, 4, toUSDC(17));

    const totalIn = toUSDC(100 + 33 + 7 + 11 + 13 + 17);
    assert.equal(await (token as any).balanceOf(wmAddr), totalIn);

    await networkHelpers.time.setNextBlockTimestamp(lock2 + 1);
    for (const id of [0n, 1n, 2n]) await (wm.connect(alice) as any).lockMarket(id);

    await (wm.connect(oracleSigner) as any).submitResult(0n, 30n); // bucket 2 wins
    await (wm.connect(oracleSigner) as any).submitResult(1n, 33n); // bucket 3, nobody bet it -> noWinner

    // ── Partial claims: only alice claims market 0, everything else stays unclaimed ──
    await (wm.connect(alice) as any).claimWinnings(0n);

    const fees1 = (await (wm as any).collectedFees()) as bigint;
    const bal1 = (await (token as any).balanceOf(wmAddr)) as bigint;

    // Unclaimed liability: bob on market 0; alice+bob on market 1 (full refund); carol on market 2 (full refund)
    const pool0 = (await (wm as any).getMarket(0n))[4] as bigint;
    const net0 = pool0 - (pool0 * 200n) / 10000n;
    const bobShare = (toUSDC(33) * net0) / (await (wm as any).bucketTotals(0n, 2) as bigint);
    const liability1 = bobShare + toUSDC(11) + toUSDC(13) + toUSDC(17);

    assert.ok(
      fees1 + liability1 <= bal1,
      `INV-3 violated: fees(${fees1}) + liability(${liability1}) > balance(${bal1})`,
    );

    // ── Everyone claims ──
    await (wm.connect(bob) as any).claimWinnings(0n);
    await (wm.connect(alice) as any).claimWinnings(1n);
    await (wm.connect(bob) as any).claimWinnings(1n);

    const timeout = Number(await (wm as any).marketLockedTimeout(2n));
    await networkHelpers.time.increaseTo(lock2 + timeout);
    await (wm.connect(carol) as any).claimRefund(2n);

    const fees2 = (await (wm as any).collectedFees()) as bigint;
    const bal2 = (await (token as any).balanceOf(wmAddr)) as bigint;
    assert.ok(fees2 <= bal2, `INV-3 violated: fees ${fees2} exceed balance ${bal2}`);

    // Only fees + rounding dust remain
    const dust = bal2 - fees2;
    assert.ok(dust >= 0n);

    // After withdrawing fees the balance is exactly the dust; carol's losing stake (7 USDC on market 0) went to the winners' pool
    await (wm.connect(owner) as any).withdrawFees();
    assert.equal(await (token as any).balanceOf(wmAddr), dust);
    assert.equal(await (wm as any).collectedFees(), 0n);
  });

  it("INV-3: withdrawFees cannot touch user principal", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy();
    const lockTime = await newMarket(wm, owner);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(500));

    // The market is unsettled, collectedFees = 0, so withdrawFees should revert outright
    await assert.rejects(
      (wm.connect(owner) as any).withdrawFees(),
      "withdrawFees should revert when there are no fees",
    );
    assert.equal(await (token as any).balanceOf(wmAddr), toUSDC(500));
    void lockTime;
  });

  // ── defaultLockedTimeout ────────────────────────────────────────────────

  it("setDefaultLockedTimeout: owner-only and bounded by MIN/MAX", async () => {
    const { owner, alice, wm } = await deploy();

    assert.equal(await (wm as any).defaultLockedTimeout(), BigInt(3 * DAY));
    assert.equal(await (wm as any).MIN_LOCKED_TIMEOUT(), BigInt(1 * DAY));
    assert.equal(await (wm as any).MAX_LOCKED_TIMEOUT(), BigInt(30 * DAY));

    await assert.rejects(
      (wm.connect(alice) as any).setDefaultLockedTimeout(7 * DAY),
      "a non-owner must not be able to change defaultLockedTimeout",
    );
    await assert.rejects(
      (wm.connect(owner) as any).setDefaultLockedTimeout(1 * DAY - 1),
      "below MIN should revert",
    );
    await assert.rejects(
      (wm.connect(owner) as any).setDefaultLockedTimeout(30 * DAY + 1),
      "above MAX should revert",
    );

    await (wm.connect(owner) as any).setDefaultLockedTimeout(7 * DAY);
    assert.equal(await (wm as any).defaultLockedTimeout(), BigInt(7 * DAY));
    // The boundary values themselves must be settable
    await (wm.connect(owner) as any).setDefaultLockedTimeout(1 * DAY);
    await (wm.connect(owner) as any).setDefaultLockedTimeout(30 * DAY);
  });

  it("setDefaultLockedTimeout only affects markets created afterwards", async () => {
    const { owner, wm } = await deploy();
    const CREATE_4 = "createMarket(string,uint256,int256[],uint256)";

    const lock0 = await newMarket(wm, owner, 0);
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(3 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lock0 + 3 * DAY));

    await (wm.connect(owner) as any).setDefaultLockedTimeout(14 * DAY);

    // An existing market's settlement deadline must not change
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(3 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lock0 + 3 * DAY));

    // Only new markets pick up the new default
    const now = await head();
    const lock1 = now + 3600;
    await (wm.connect(owner) as any)[CREATE_4]("Tokyo", now + 7200, BUCKETS, lock1);
    assert.equal(await (wm as any).marketLockedTimeout(1n), BigInt(14 * DAY));
    assert.equal(await (wm as any).settlementDeadline(1n), BigInt(lock1 + 14 * DAY));
  });

  it("the 5-argument createMarket sets that market's lockedTimeout", async () => {
    const { owner, wm } = await deploy();
    const CREATE_5 = "createMarket(string,uint256,int256[],uint256,uint256)";
    const now = await head();
    const lockTime = now + 3600;

    await (wm.connect(owner) as any)[CREATE_5]("Seoul", now + 7200, BUCKETS, lockTime, 7 * DAY);
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(7 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lockTime + 7 * DAY));

    await assert.rejects(
      (wm.connect(owner) as any)[CREATE_5]("Seoul", now + 7200, BUCKETS, lockTime, 31 * DAY),
      "above MAX_LOCKED_TIMEOUT should revert",
    );
  });

  // ── createMarket time bounds ──────────────────────────────────────────────

  it("createMarket: the lockTime and targetDate upper bounds are enforced", async () => {
    const { owner, wm } = await deploy();
    const now = await head();

    await assert.rejects(
      (wm.connect(owner) as any).createMarket("Taipei", now + 91 * DAY + 7200, BUCKETS, now + 91 * DAY),
      "a lockTime more than 90 days out should revert",
    );
    await assert.rejects(
      (wm.connect(owner) as any).createMarket("Taipei", now + 3600 + 91 * DAY, BUCKETS, now + 3600),
      "a targetDate more than 90 days past lockTime should revert",
    );
    // Inside the bounds creation succeeds
    await (wm.connect(owner) as any).createMarket("Taipei", now + 3600 + 89 * DAY, BUCKETS, now + 89 * DAY);
    assert.equal(await (wm as any).nextMarketId(), 1n);
  });
});
