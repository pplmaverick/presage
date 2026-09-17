import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers, type JsonRpcSigner } from "ethers";
import { network } from "hardhat";
import hre from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// Independent Reference Model 對照測試
//
// verification/reference_model.py 只依規格計算每個案例的期望值，
// 並把每筆 trace 的 SHA-256 寫進 verification/commitments.sha256。
// 這支測試拿真實合約跑同一批案例，用實際鏈上結果重建 trace、重算 SHA-256，
// 再跟 Python 的承諾比對。兩邊必須逐位元組相同。
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFICATION_DIR = resolve(__dirname, "../verification");

interface CaseSpec {
  name: string;
  mode: "settle" | "settle_revert" | "refund" | "refund_revert" | "lock_revert" | "create_revert";
  at: string;
  lockedTimeout: string | null;
  buckets: string[];
  bets: [number, number, string][];
  finalTemp: string | null;
  revertReason: string | null;
  expected: Trace;
  sha256: string;
}

interface Trace {
  case: string;
  outcome: "settle" | "refund" | "revert";
  lockedTimeout: string;
  buckets: string[];
  finalTemp: string | null;
  winningBucket: number | null;
  noWinner: boolean | null;
  totalPool: string;
  fee: string;
  dust: string;
  payouts: [number, string, string][];
  revertReason: string | null;
}

const fixture = JSON.parse(
  readFileSync(resolve(VERIFICATION_DIR, "cases.json"), "utf-8"),
) as {
  feeBps: number;
  defaultLockedTimeout: number;
  minLockedTimeout: number;
  maxLockedTimeout: number;
  caseCount: number;
  cases: CaseSpec[];
};

const commitments = new Map<string, string>();
for (const line of readFileSync(resolve(VERIFICATION_DIR, "commitments.sha256"), "utf-8").split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [digest, name] = line.trim().split(/\s+/);
  commitments.set(name, digest);
}

// 必須與 reference_model.py 的 canonical() 產出完全相同的位元組：
// key 依序排列、無空白、非 ASCII 不轉義。
function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function revertText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; reason?: string };
  return e?.reason ?? e?.shortMessage ?? e?.message ?? String(err);
}

describe("WeatherMarket — Independent Reference Model", async function () {
  const conn = await network.create();
  const { networkHelpers } = conn; // 只用 time helper，不用 loadFixture
  const provider = new ethers.BrowserProvider(conn.provider as any);
  const rawProvider = conn.provider as { request: (a: unknown) => Promise<any> };

  const MINT = 10_000_000_000n; // 10,000 USDC，足夠覆蓋所有案例

  // ethers 的 BrowserProvider 會對 getBlock("latest") 做短期快取，在這種
  // 「每個案例都把鏈往前推 72 小時」的測試裡會讀到過期的 timestamp。
  // 時間一律走 raw RPC 拿，不經過快取。
  async function chainHeadTimestamp(): Promise<number> {
    const b = await rawProvider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    return Number(BigInt(b.timestamp));
  }

  // 刻意不用 networkHelpers.loadFixture：fixture 靠 snapshot revert 還原狀態，
  // 而這批案例每個都會呼叫 setNextBlockTimestamp 把鏈往前推 72 小時，
  // snapshot 還原與時間覆寫混用時會出現「eth_call 讀得到下注、但交易執行時
  // 讀不到」的錯配。每個案例直接部署一組全新合約，換來完全確定的行為。
  async function deployFresh() {
    const accounts = (await provider.listAccounts()) as JsonRpcSigner[];
    const [owner, alice, bob, carol, oracleSigner] = accounts;
    const users = [alice, bob, carol];

    const usdcArt = await hre.artifacts.readArtifact("MockUSDC");
    const mockUSDC = await new ethers.ContractFactory(
      usdcArt.abi, usdcArt.bytecode, owner,
    ).deploy();
    await mockUSDC.waitForDeployment();
    const usdcAddr = await mockUSDC.getAddress();

    const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
    const weatherMarket = await new ethers.ContractFactory(
      wmArt.abi, wmArt.bytecode, owner,
    ).deploy(usdcAddr, oracleSigner.address);
    await weatherMarket.waitForDeployment();
    const wmAddr = await weatherMarket.getAddress();

    for (const u of users) {
      await (mockUSDC.connect(owner) as any).mint(u.address, MINT);
      await (mockUSDC.connect(u) as any).approve(wmAddr, MINT);
    }

    return { owner, users, oracleSigner, mockUSDC, weatherMarket, wmAddr };
  }

  // 合約常數必須與模型假設一致，否則整批比對沒有意義
  it("model constants match the deployed contract", async () => {
    const { weatherMarket } = await deployFresh();
    assert.equal(
      await (weatherMarket as any).FEE_BPS(),
      BigInt(fixture.feeBps),
      "FEE_BPS 與 reference model 不一致",
    );
    assert.equal(
      await (weatherMarket as any).defaultLockedTimeout(),
      BigInt(fixture.defaultLockedTimeout),
      "defaultLockedTimeout 與 reference model 不一致",
    );
    assert.equal(
      await (weatherMarket as any).MIN_LOCKED_TIMEOUT(),
      BigInt(fixture.minLockedTimeout),
      "MIN_LOCKED_TIMEOUT 與 reference model 不一致",
    );
    assert.equal(
      await (weatherMarket as any).MAX_LOCKED_TIMEOUT(),
      BigInt(fixture.maxLockedTimeout),
      "MAX_LOCKED_TIMEOUT 與 reference model 不一致",
    );
  });

  it("every case in cases.json has a matching commitment", () => {
    assert.equal(fixture.cases.length, fixture.caseCount);
    assert.equal(commitments.size, fixture.caseCount);
    for (const c of fixture.cases) {
      assert.equal(commitments.get(c.name), c.sha256, `${c.name} 的承諾不一致`);
    }
  });

  for (const spec of fixture.cases) {
    it(`IRM: ${spec.name}`, async () => {
      const { users, oracleSigner, mockUSDC, weatherMarket, wmAddr } =
        await deployFresh();

      const buckets = spec.buckets.map(BigInt);
      const now = await chainHeadTimestamp();
      const lockTime = now + 3600;
      const targetDate = now + 7200;

      const CREATE_4 = "createMarket(string,uint256,int256[],uint256)";
      const CREATE_5 = "createMarket(string,uint256,int256[],uint256,uint256)";

      // ── createMarket 的 lockedTimeout 超出 MIN/MAX ──────────────────────
      if (spec.mode === "create_revert") {
        let reverted = false;
        let text = "";
        try {
          await (weatherMarket as any)[CREATE_5](
            "Taipei", targetDate, buckets, lockTime, BigInt(spec.lockedTimeout!),
          );
        } catch (err) {
          reverted = true;
          text = revertText(err);
        }
        assert.ok(reverted, "超出範圍的 lockedTimeout 應該 revert 但建立成功了");
        assert.ok(
          text.includes(spec.revertReason!),
          `revert 訊息不含 "${spec.revertReason}"：${text}`,
        );
        assert.equal(await (weatherMarket as any).nextMarketId(), 0n, "不該留下市場");

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets, finalTemp: spec.finalTemp,
          winningBucket: null, noWinner: null,
          totalPool: "0", fee: "0", dust: "0", payouts: [],
          revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 不符");
        return;
      }

      if (spec.lockedTimeout === null) {
        await (weatherMarket as any)[CREATE_4]("Taipei", targetDate, buckets, lockTime);
      } else {
        await (weatherMarket as any)[CREATE_5](
          "Taipei", targetDate, buckets, lockTime, BigInt(spec.lockedTimeout),
        );
      }
      const marketId = 0n;

      // 該市場實際寫入的 lockedTimeout（不是全域常數）
      const marketTimeout = (await (weatherMarket as any).marketLockedTimeout(marketId)) as bigint;
      assert.equal(
        marketTimeout.toString(),
        spec.expected.lockedTimeout,
        "市場寫入的 lockedTimeout 與 reference model 不一致",
      );

      for (const [u, bucket, amount] of spec.bets) {
        await (weatherMarket.connect(users[u]) as any).placeBet(marketId, bucket, BigInt(amount));
      }

      const deadline = Number(
        (await (weatherMarket as any).settlementDeadline(marketId)) as bigint,
      );
      assert.equal(deadline, lockTime + Number(marketTimeout));

      const AT: Record<string, number> = {
        lock_time_plus_1: lockTime + 1,
        timeout_minus_3600: deadline - 3600,
        timeout_minus_1: deadline - 1,
        timeout_exact: deadline,
        timeout_plus_1: deadline + 1,
      };
      const targetTs = AT[spec.at];
      assert.ok(targetTs !== undefined, `未知的 at="${spec.at}"`);

      // ── lockMarket 對不存在 marketId ─────────────────────────────────
      if (spec.mode === "lock_revert") {
        await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
        let reverted = false;
        let text = "";
        try {
          await (weatherMarket as any).lockMarket(999n);
        } catch (err) {
          reverted = true;
          text = revertText(err);
        }
        assert.ok(reverted, "lockMarket(999) 應該 revert 但成功了");
        assert.ok(
          text.includes(spec.revertReason!),
          `revert 訊息不含 "${spec.revertReason}"：${text}`,
        );

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: "0", fee: "0", dust: "0", payouts: [],
          revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 不符");
        return;
      }

      // ── 鎖盤 ─────────────────────────────────────────────────────────
      await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
      await (weatherMarket as any).lockMarket(marketId);

      const totalPoolOnChain = (await (weatherMarket as any).getMarket(marketId))[4] as bigint;

      // ── 結算窗口已關閉 → submitResult 應 revert ───────────────────────
      if (spec.mode === "settle_revert") {
        await networkHelpers.time.setNextBlockTimestamp(targetTs);
        let reverted = false;
        let text = "";
        try {
          await (weatherMarket.connect(oracleSigner) as any)
            .submitResult(marketId, BigInt(spec.finalTemp!));
        } catch (err) {
          reverted = true;
          text = revertText(err);
        }
        assert.ok(reverted, "submitResult 應該 revert 但成功了");
        assert.ok(text.includes(spec.revertReason!), `revert 訊息：${text}`);

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: totalPoolOnChain.toString(), fee: "0", dust: "0",
          payouts: [], revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 不符");
        // 錢還在合約裡，一分沒少
        assert.equal(await (mockUSDC as any).balanceOf(wmAddr), totalPoolOnChain);
        return;
      }

      // ── 退款窗口未開 → claimRefund 應 revert ─────────────────────────
      if (spec.mode === "refund_revert") {
        await networkHelpers.time.setNextBlockTimestamp(targetTs);
        const firstBettor = users[spec.bets[0][0]];
        let reverted = false;
        let text = "";
        try {
          await (weatherMarket.connect(firstBettor) as any).claimRefund(marketId);
        } catch (err) {
          reverted = true;
          text = revertText(err);
        }
        assert.ok(reverted, "claimRefund 應該 revert 但成功了");
        assert.ok(text.includes(spec.revertReason!), `revert 訊息：${text}`);

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: totalPoolOnChain.toString(), fee: "0", dust: "0",
          payouts: [], revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 不符");
        assert.equal(await (mockUSDC as any).balanceOf(wmAddr), totalPoolOnChain);
        return;
      }

      // ── settle / refund ──────────────────────────────────────────────
      let winningBucket: number | null = null;
      let noWinner: boolean | null = null;
      let outcome: "settle" | "refund";

      await networkHelpers.time.setNextBlockTimestamp(targetTs);

      if (spec.mode === "settle") {
        await (weatherMarket.connect(oracleSigner) as any)
          .submitResult(marketId, BigInt(spec.finalTemp!));
        const m = await (weatherMarket as any).getMarket(marketId);
        winningBucket = Number(m[6]);
        noWinner = m[8] as boolean;
        outcome = "settle";
      } else {
        outcome = "refund";
      }

      const fee = (await (weatherMarket as any).collectedFees()) as bigint;

      // 每個下過注的人都試著領一次，成功就記實際入帳金額，失敗就記 revert。
      // 不看模型的期望值決定要不要領，否則就是拿答案對答案。
      const bettors = [...new Set(spec.bets.map(([u]) => u))].sort((a, b) => a - b);
      const payouts: [number, string, string][] = [];
      let distributed = 0n;

      for (const u of bettors) {
        const signer = users[u];
        const before = (await (mockUSDC as any).balanceOf(signer.address)) as bigint;
        try {
          if (outcome === "settle") {
            await (weatherMarket.connect(signer) as any).claimWinnings(marketId);
          } else {
            await (weatherMarket.connect(signer) as any).claimRefund(marketId);
          }
          const got = ((await (mockUSDC as any).balanceOf(signer.address)) as bigint) - before;
          payouts.push([u, "claimable", got.toString()]);
          distributed += got;
        } catch (err) {
          if (process.env.IRM_DEBUG) {
            console.error(`    [debug] ${spec.name} user ${u} claim failed:`, revertText(err));
          }
          payouts.push([u, "revert", "0"]);
        }
      }

      const dust = totalPoolOnChain - fee - distributed;

      const actual: Trace = {
        case: spec.name,
        outcome,
        lockedTimeout: marketTimeout.toString(),
        buckets: spec.buckets,
        finalTemp: spec.finalTemp,
        winningBucket,
        noWinner,
        totalPool: totalPoolOnChain.toString(),
        fee: fee.toString(),
        dust: dust.toString(),
        payouts,
        revertReason: null,
      };

      // 先做逐欄位比對，失敗時訊息比雜湊好讀
      assert.deepEqual(actual, spec.expected, `${spec.name}: 與 reference model 不一致`);
      // 再做承諾比對
      assert.equal(sha256(canonical(actual)), spec.sha256, `${spec.name}: trace SHA-256 不符`);

      // ── INV-3：collectedFees + 未領取負債 <= 合約 USDC 餘額 ──────────
      // 這裡所有人都已領完，未領取負債 = 0，餘額應恰好等於 fee + dust。
      const contractBalance = (await (mockUSDC as any).balanceOf(wmAddr)) as bigint;
      assert.equal(contractBalance, fee + dust, "INV-3: 餘額不等於 fee + dust");
      assert.ok(fee <= contractBalance, "INV-3: collectedFees 超過合約餘額");

      // 二次領取必須全部被擋
      for (const u of bettors) {
        await assert.rejects(
          outcome === "settle"
            ? (weatherMarket.connect(users[u]) as any).claimWinnings(marketId)
            : (weatherMarket.connect(users[u]) as any).claimRefund(marketId),
          `user ${u} 的二次領取沒有被擋下`,
        );
      }
    });
  }
});
