import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers, type JsonRpcSigner } from "ethers";
import { network } from "hardhat";
import hre from "hardhat";

// INV-1 ~ INV-4 的專屬驗證。
// IRM 測試負責「算出來的數字對不對」，這支負責「不變量在惡意/邊界輸入下守不守得住」。

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

  it("INV-4: placeBet 的 transferFrom 重入會被 nonReentrant 擋下", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy("ReentrantUSDC");
    await newMarket(wm, owner);

    // 讓 token 在 transferFrom 期間回呼 placeBet
    await (token as any).arm(wmAddr, 0n, 2, toUSDC(1));

    await assert.rejects(
      (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100)),
      "重入的 placeBet 沒有被擋下",
    );

    // 整筆交易 revert，帳面與餘額都不該留下痕跡
    assert.equal(await (token as any).balanceOf(wmAddr), 0n);
    assert.equal((await (wm as any).getMarket(0n))[4], 0n);
    assert.equal(await (wm as any).bucketTotals(0n, 2), 0n);
  });

  it("INV-4: fee-on-transfer 代幣會讓 placeBet 整筆 revert（記帳不會虛增）", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy("FeeOnTransferUSDC");
    await newMarket(wm, owner);

    await assert.rejects(
      (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100)),
      "fee-on-transfer 沒有被 received == amount 檢查擋下",
    );
    assert.equal(await (token as any).balanceOf(wmAddr), 0n);
    assert.equal((await (wm as any).getMarket(0n))[4], 0n);
  });

  it("INV-4: 正常 ERC20 下 placeBet 記帳與實收金額一致", async () => {
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

  it("INV-2: lockMarket 對 marketId >= nextMarketId 一律 revert", async () => {
    const { owner, alice, wm } = await deploy();
    const lockTime = await newMarket(wm, owner);
    assert.equal(await (wm as any).nextMarketId(), 1n);

    await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
    for (const bad of [1n, 2n, 999n, 2n ** 64n]) {
      await assert.rejects(
        (wm.connect(alice) as any).lockMarket(bad),
        `lockMarket(${bad}) 應該 revert`,
      );
    }
    // 存在的市場仍可正常鎖
    await (wm.connect(alice) as any).lockMarket(0n);
    assert.equal((await (wm as any).getMarket(0n))[3], 1n);
  });

  // ── INV-1 ────────────────────────────────────────────────────────────────

  it("INV-1: LOCKED 超時後可 claimRefund，且結算窗口同時關閉（互斥）", async () => {
    const { owner, alice, bob, oracleSigner, wm, wmAddr, token } = await deploy();
    const lockTime = await newMarket(wm, owner);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await (wm.connect(bob) as any).placeBet(0n, 3, toUSDC(50));

    await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
    await (wm.connect(alice) as any).lockMarket(0n);

    const timeout = Number(await (wm as any).marketLockedTimeout(0n));
    assert.equal(timeout, 3 * DAY, "未指定時應採用 defaultLockedTimeout（3 天）");
    const deadline = lockTime + timeout;
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(deadline));

    // 這裡用 increaseTo 實際把鏈頭推上去，而不是 setNextBlockTimestamp：
    // ethers 送交易前會先 eth_estimateGas，而一筆 revert 掉的 estimateGas
    // 會把 setNextBlockTimestamp 的覆寫清掉，導致後面那筆交易落在舊時間。
    // 精確到秒的邊界（deadline-1 / deadline / deadline+1）由 IRM 測試覆蓋。

    // 窗口內：不能退款（下一筆交易會落在 deadline - 1）
    await networkHelpers.time.increaseTo(deadline - 2);
    await assert.rejects((wm.connect(alice) as any).claimRefund(0n));

    // 窗口關閉後：不能結算，只能退款（下一筆交易會落在 deadline + 1）
    await networkHelpers.time.increaseTo(deadline);
    await assert.rejects(
      (wm.connect(oracleSigner) as any).submitResult(0n, 30n),
      "結算窗口關閉後 submitResult 應 revert",
    );

    // 明確給 gasLimit 是為了跳過 ethers 的 eth_estimateGas。EDR 在前面幾筆
    // revert 掉的 estimateGas 之後，會用比鏈頭還舊的 timestamp 去模擬，
    // 導致這筆本來該成功的交易在 estimateGas 階段被誤判成 revert。
    // 交易本身的執行是正確的（下面的金額斷言會驗證）。
    const aliceBefore = (await (token as any).balanceOf(alice.address)) as bigint;
    await (wm.connect(alice) as any).claimRefund(0n, { gasLimit: 200_000 });
    assert.equal(
      ((await (token as any).balanceOf(alice.address)) as bigint) - aliceBefore,
      toUSDC(100),
      "退款應為本金全額，不扣手續費",
    );

    // 二次退款要被擋
    await assert.rejects((wm.connect(alice) as any).claimRefund(0n));

    await (wm.connect(bob) as any).claimRefund(0n);
    assert.equal(await (token as any).balanceOf(wmAddr), 0n, "全數退完合約應歸零");
    assert.equal(await (wm as any).collectedFees(), 0n, "退款路徑不得產生手續費");
  });

  it("INV-1: 已 SETTLED 的市場不能走 claimRefund", async () => {
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
      "SETTLED 市場不該能退款",
    );
    // 正常領獎仍可用
    await (wm.connect(alice) as any).claimWinnings(0n);
    await assert.rejects((wm.connect(alice) as any).claimWinnings(0n));
  });

  // ── INV-3 ────────────────────────────────────────────────────────────────

  it("INV-3: 多市場、部分領取的狀態下 collectedFees + 未領負債 <= 合約餘額", async () => {
    const { owner, alice, bob, carol, oracleSigner, wm, wmAddr, token } = await deploy();

    // 市場 0：有得獎者，alice/bob 押同一 bucket，carol 押輸
    const lock0 = await newMarket(wm, owner, 0);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(100));
    await (wm.connect(bob) as any).placeBet(0n, 2, toUSDC(33));
    await (wm.connect(carol) as any).placeBet(0n, 0, toUSDC(7));

    // 市場 1：無人押中 → 全額退款
    const lock1 = await newMarket(wm, owner, 60);
    await (wm.connect(alice) as any).placeBet(1n, 0, toUSDC(11));
    await (wm.connect(bob) as any).placeBet(1n, 1, toUSDC(13));

    // 市場 2：鎖了但不結算 → 走 INV-1 退款路徑
    const lock2 = await newMarket(wm, owner, 120);
    await (wm.connect(carol) as any).placeBet(2n, 4, toUSDC(17));

    const totalIn = toUSDC(100 + 33 + 7 + 11 + 13 + 17);
    assert.equal(await (token as any).balanceOf(wmAddr), totalIn);

    await networkHelpers.time.setNextBlockTimestamp(lock2 + 1);
    for (const id of [0n, 1n, 2n]) await (wm.connect(alice) as any).lockMarket(id);

    await (wm.connect(oracleSigner) as any).submitResult(0n, 30n); // bucket 2 wins
    await (wm.connect(oracleSigner) as any).submitResult(1n, 33n); // bucket 3，無人押 → noWinner

    // ── 部分領取：只有 alice 領市場 0，其餘全部未領 ──
    await (wm.connect(alice) as any).claimWinnings(0n);

    const fees1 = (await (wm as any).collectedFees()) as bigint;
    const bal1 = (await (token as any).balanceOf(wmAddr)) as bigint;

    // 尚未領取的負債：市場0 的 bob；市場1 的 alice+bob（全額退）；市場2 的 carol（全額退）
    const pool0 = (await (wm as any).getMarket(0n))[4] as bigint;
    const net0 = pool0 - (pool0 * 200n) / 10000n;
    const bobShare = (toUSDC(33) * net0) / (await (wm as any).bucketTotals(0n, 2) as bigint);
    const liability1 = bobShare + toUSDC(11) + toUSDC(13) + toUSDC(17);

    assert.ok(
      fees1 + liability1 <= bal1,
      `INV-3 破損：fees(${fees1}) + 負債(${liability1}) > 餘額(${bal1})`,
    );

    // ── 全部領完 ──
    await (wm.connect(bob) as any).claimWinnings(0n);
    await (wm.connect(alice) as any).claimWinnings(1n);
    await (wm.connect(bob) as any).claimWinnings(1n);

    const timeout = Number(await (wm as any).marketLockedTimeout(2n));
    await networkHelpers.time.increaseTo(lock2 + timeout);
    await (wm.connect(carol) as any).claimRefund(2n);

    const fees2 = (await (wm as any).collectedFees()) as bigint;
    const bal2 = (await (token as any).balanceOf(wmAddr)) as bigint;
    assert.ok(fees2 <= bal2, `INV-3 破損：手續費 ${fees2} 超過餘額 ${bal2}`);

    // 只剩手續費 + rounding dust
    const dust = bal2 - fees2;
    assert.ok(dust >= 0n);

    // 提完手續費後，餘額恰為 dust，且 carol 的輸注（市場 0 的 7 USDC）已進入得獎池
    await (wm.connect(owner) as any).withdrawFees();
    assert.equal(await (token as any).balanceOf(wmAddr), dust);
    assert.equal(await (wm as any).collectedFees(), 0n);
  });

  it("INV-3: withdrawFees 動不到使用者本金", async () => {
    const { owner, alice, wm, wmAddr, token } = await deploy();
    const lockTime = await newMarket(wm, owner);
    await (wm.connect(alice) as any).placeBet(0n, 2, toUSDC(500));

    // 市場還沒結算，collectedFees = 0，withdrawFees 應直接 revert
    await assert.rejects(
      (wm.connect(owner) as any).withdrawFees(),
      "沒有手續費時 withdrawFees 應 revert",
    );
    assert.equal(await (token as any).balanceOf(wmAddr), toUSDC(500));
    void lockTime;
  });

  // ── defaultLockedTimeout ────────────────────────────────────────────────

  it("setDefaultLockedTimeout: 只有 owner 能改，且受 MIN/MAX 邊界限制", async () => {
    const { owner, alice, wm } = await deploy();

    assert.equal(await (wm as any).defaultLockedTimeout(), BigInt(3 * DAY));
    assert.equal(await (wm as any).MIN_LOCKED_TIMEOUT(), BigInt(1 * DAY));
    assert.equal(await (wm as any).MAX_LOCKED_TIMEOUT(), BigInt(30 * DAY));

    await assert.rejects(
      (wm.connect(alice) as any).setDefaultLockedTimeout(7 * DAY),
      "非 owner 不該能改 defaultLockedTimeout",
    );
    await assert.rejects(
      (wm.connect(owner) as any).setDefaultLockedTimeout(1 * DAY - 1),
      "低於 MIN 應 revert",
    );
    await assert.rejects(
      (wm.connect(owner) as any).setDefaultLockedTimeout(30 * DAY + 1),
      "高於 MAX 應 revert",
    );

    await (wm.connect(owner) as any).setDefaultLockedTimeout(7 * DAY);
    assert.equal(await (wm as any).defaultLockedTimeout(), BigInt(7 * DAY));
    // 邊界值本身要能設
    await (wm.connect(owner) as any).setDefaultLockedTimeout(1 * DAY);
    await (wm.connect(owner) as any).setDefaultLockedTimeout(30 * DAY);
  });

  it("setDefaultLockedTimeout 只影響之後新建立的市場", async () => {
    const { owner, wm } = await deploy();
    const CREATE_4 = "createMarket(string,uint256,int256[],uint256)";

    const lock0 = await newMarket(wm, owner, 0);
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(3 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lock0 + 3 * DAY));

    await (wm.connect(owner) as any).setDefaultLockedTimeout(14 * DAY);

    // 既有市場的結算截止時間不得改變
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(3 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lock0 + 3 * DAY));

    // 新市場才套用新預設
    const now = await head();
    const lock1 = now + 3600;
    await (wm.connect(owner) as any)[CREATE_4]("Tokyo", now + 7200, BUCKETS, lock1);
    assert.equal(await (wm as any).marketLockedTimeout(1n), BigInt(14 * DAY));
    assert.equal(await (wm as any).settlementDeadline(1n), BigInt(lock1 + 14 * DAY));
  });

  it("createMarket 5 參數版可指定該市場的 lockedTimeout", async () => {
    const { owner, wm } = await deploy();
    const CREATE_5 = "createMarket(string,uint256,int256[],uint256,uint256)";
    const now = await head();
    const lockTime = now + 3600;

    await (wm.connect(owner) as any)[CREATE_5]("Seoul", now + 7200, BUCKETS, lockTime, 7 * DAY);
    assert.equal(await (wm as any).marketLockedTimeout(0n), BigInt(7 * DAY));
    assert.equal(await (wm as any).settlementDeadline(0n), BigInt(lockTime + 7 * DAY));

    await assert.rejects(
      (wm.connect(owner) as any)[CREATE_5]("Seoul", now + 7200, BUCKETS, lockTime, 31 * DAY),
      "超過 MAX_LOCKED_TIMEOUT 應 revert",
    );
  });

  // ── createMarket 時間上限 ────────────────────────────────────────────────

  it("createMarket: lockTime 與 targetDate 的上限生效", async () => {
    const { owner, wm } = await deploy();
    const now = await head();

    await assert.rejects(
      (wm.connect(owner) as any).createMarket("Taipei", now + 91 * DAY + 7200, BUCKETS, now + 91 * DAY),
      "lockTime 超過 90 天應 revert",
    );
    await assert.rejects(
      (wm.connect(owner) as any).createMarket("Taipei", now + 3600 + 91 * DAY, BUCKETS, now + 3600),
      "targetDate 超過 lockTime + 90 天應 revert",
    );
    // 邊界內可以建
    await (wm.connect(owner) as any).createMarket("Taipei", now + 3600 + 89 * DAY, BUCKETS, now + 89 * DAY);
    assert.equal(await (wm as any).nextMarketId(), 1n);
  });
});
