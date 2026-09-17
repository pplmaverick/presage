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
// Independent Reference Model cross-check.
//
// verification/reference_model.py derives the expected outcome of every case from the
// specification alone and writes the SHA-256 of each trace to
// verification/commitments.sha256. This test runs the same cases against the real
// contracts, rebuilds each trace from the actual on-chain results, recomputes the
// SHA-256 and compares it to the Python commitment. The two must match byte for byte.
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

// Must produce exactly the same bytes as canonical() in reference_model.py:
// keys sorted, no whitespace, non-ASCII left unescaped.
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
  const { networkHelpers } = conn; // time helpers only, no loadFixture
  const provider = new ethers.BrowserProvider(conn.provider as any);
  const rawProvider = conn.provider as { request: (a: unknown) => Promise<any> };

  const MINT = 10_000_000_000n; // 10,000 USDC, enough for every case

  // ethers' BrowserProvider briefly caches getBlock("latest"), which returns a stale
  // timestamp in a suite like this where every case pushes the chain 72 hours forward.
  // Timestamps are always read through raw RPC so the cache is bypassed.
  async function chainHeadTimestamp(): Promise<number> {
    const b = await rawProvider.request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    return Number(BigInt(b.timestamp));
  }

  // networkHelpers.loadFixture is deliberately not used. Fixtures restore state by
  // reverting to a snapshot, and every case here calls setNextBlockTimestamp to push the
  // chain 72 hours forward. Mixing snapshot restores with timestamp overrides produced a
  // mismatch where eth_call could see a bet but the transaction executing against it
  // could not. Deploying a fresh set of contracts per case buys fully deterministic behaviour.
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

  // The contract constants must match the model's assumptions, or the whole comparison is meaningless
  it("model constants match the deployed contract", async () => {
    const { weatherMarket } = await deployFresh();
    assert.equal(
      await (weatherMarket as any).FEE_BPS(),
      BigInt(fixture.feeBps),
      "FEE_BPS does not match the reference model",
    );
    assert.equal(
      await (weatherMarket as any).defaultLockedTimeout(),
      BigInt(fixture.defaultLockedTimeout),
      "defaultLockedTimeout does not match the reference model",
    );
    assert.equal(
      await (weatherMarket as any).MIN_LOCKED_TIMEOUT(),
      BigInt(fixture.minLockedTimeout),
      "MIN_LOCKED_TIMEOUT does not match the reference model",
    );
    assert.equal(
      await (weatherMarket as any).MAX_LOCKED_TIMEOUT(),
      BigInt(fixture.maxLockedTimeout),
      "MAX_LOCKED_TIMEOUT does not match the reference model",
    );
  });

  it("every case in cases.json has a matching commitment", () => {
    assert.equal(fixture.cases.length, fixture.caseCount);
    assert.equal(commitments.size, fixture.caseCount);
    for (const c of fixture.cases) {
      assert.equal(commitments.get(c.name), c.sha256, `commitment mismatch for ${c.name}`);
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

      // ── createMarket with lockedTimeout outside MIN/MAX ────────────────────
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
        assert.ok(reverted, "an out-of-range lockedTimeout should revert, but creation succeeded");
        assert.ok(
          text.includes(spec.revertReason!),
          `revert message does not contain "${spec.revertReason}": ${text}`,
        );
        assert.equal(await (weatherMarket as any).nextMarketId(), 0n, "no market should have been created");

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets, finalTemp: spec.finalTemp,
          winningBucket: null, noWinner: null,
          totalPool: "0", fee: "0", dust: "0", payouts: [],
          revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 mismatch");
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

      // The lockedTimeout actually stored on this market (not a global constant)
      const marketTimeout = (await (weatherMarket as any).marketLockedTimeout(marketId)) as bigint;
      assert.equal(
        marketTimeout.toString(),
        spec.expected.lockedTimeout,
        "the market's stored lockedTimeout does not match the reference model",
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
      assert.ok(targetTs !== undefined, `unknown at="${spec.at}"`);

      // ── lockMarket on a nonexistent marketId ──────────────────────────
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
        assert.ok(reverted, "lockMarket(999) should revert, but it succeeded");
        assert.ok(
          text.includes(spec.revertReason!),
          `revert message does not contain "${spec.revertReason}": ${text}`,
        );

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: "0", fee: "0", dust: "0", payouts: [],
          revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 mismatch");
        return;
      }

      // ── Lock the market ───────────────────────────────────────────────
      await networkHelpers.time.setNextBlockTimestamp(lockTime + 1);
      await (weatherMarket as any).lockMarket(marketId);

      const totalPoolOnChain = (await (weatherMarket as any).getMarket(marketId))[4] as bigint;

      // ── Settlement window closed -> submitResult must revert ──────────
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
        assert.ok(reverted, "submitResult should revert, but it succeeded");
        assert.ok(text.includes(spec.revertReason!), `revert message: ${text}`);

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: totalPoolOnChain.toString(), fee: "0", dust: "0",
          payouts: [], revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 mismatch");
        // The money is still in the contract, untouched
        assert.equal(await (mockUSDC as any).balanceOf(wmAddr), totalPoolOnChain);
        return;
      }

      // ── Refund window not open -> claimRefund must revert ─────────────
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
        assert.ok(reverted, "claimRefund should revert, but it succeeded");
        assert.ok(text.includes(spec.revertReason!), `revert message: ${text}`);

        const actual: Trace = {
          case: spec.name, outcome: "revert",
          lockedTimeout: spec.expected.lockedTimeout,
          buckets: spec.buckets,
          finalTemp: spec.finalTemp, winningBucket: null, noWinner: null,
          totalPool: totalPoolOnChain.toString(), fee: "0", dust: "0",
          payouts: [], revertReason: spec.revertReason,
        };
        assert.equal(sha256(canonical(actual)), spec.sha256, "trace SHA-256 mismatch");
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

      // Every bettor attempts exactly one claim: on success record the amount actually
      // received, on failure record a revert. The model's expected values never decide
      // whether to attempt a claim — that would be checking the answer against itself.
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

      // Field-by-field comparison first: the failure message is far more readable than a hash
      assert.deepEqual(actual, spec.expected, `${spec.name}: does not match the reference model`);
      // Then the commitment comparison
      assert.equal(sha256(canonical(actual)), spec.sha256, `${spec.name}: trace SHA-256 mismatch`);

      // ── INV-3: collectedFees + unclaimed liability <= contract USDC balance ──
      // Everyone has claimed here, so the unclaimed liability is 0 and the balance
      // should be exactly fee + dust.
      const contractBalance = (await (mockUSDC as any).balanceOf(wmAddr)) as bigint;
      assert.equal(contractBalance, fee + dust, "INV-3: balance is not equal to fee + dust");
      assert.ok(fee <= contractBalance, "INV-3: collectedFees exceeds the contract balance");

      // Every second claim attempt must be rejected
      for (const u of bettors) {
        await assert.rejects(
          outcome === "settle"
            ? (weatherMarket.connect(users[u]) as any).claimWinnings(marketId)
            : (weatherMarket.connect(users[u]) as any).claimRefund(marketId),
          `user ${u}'s second claim was not rejected`,
        );
      }
    });
  }
});
