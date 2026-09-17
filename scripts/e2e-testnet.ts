/**
 * End-to-end verification on Arc Testnet using real on-chain transactions — no mocks.
 *
 * Two wallets:
 *   A = dev wallet (owner of WeatherMarket / AdminOracle)
 *   B = ordinary user wallet (not the owner), used for betting and claiming
 *
 * Creates two markets:
 *   M1 settlement path: create -> B bets -> B locks (permissionless) -> A submits the
 *                       real temperature -> B claims
 *   M2 refund path:     create (lockedTimeout = MIN_LOCKED_TIMEOUT = 1 day) -> B bets ->
 *                       lock. claimRefund only becomes possible 24 hours later, so this
 *                       script only takes it to the "waiting" state.
 *
 * Usage:
 *   NETWORK=arc-testnet ARC_RPC_URL=https://rpc.testnet.arc.io \
 *     npx hardhat run scripts/e2e-testnet.ts --network arc
 */
import hre from "hardhat";
import dotenv from "dotenv";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  STATUS,
  STATUS_LABEL,
  assertChainId,
  computeFees,
  makeClients,
  readMarket,
  resolveNetwork,
} from "./lib/ops.js";

dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));

const LOG_PATH = resolve(
  __dirname,
  `../verification/e2e-testnet-${process.env.E2E_RUN_TAG ?? "run"}.md`,
);
const log: string[] = [];
function rec(line: string) {
  console.log(line);
  log.push(line);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// M1 uses a short betting window so the settlement path completes within one session.
// The admin panel's smallest dropdown option is 24 hours; this deliberately uses the
// contract-level floor instead to compress the verification time. The difference is
// called out in the report.
const M1_LOCK_DELAY = 150;        // seconds
const M1_LOCKED_TIMEOUT = 86_400; // MIN_LOCKED_TIMEOUT
const M2_LOCK_DELAY = 90;
const M2_LOCKED_TIMEOUT = 86_400;

const BUCKETS = [25n, 28n, 31n, 34n];

// Resolve which bucket a temperature falls into, per the spec (same as the contract's
// _determineWinningBucket)
function bucketFor(temp: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (BigInt(temp) <= BUCKETS[i]) return i;
  return BUCKETS.length;
}

async function fetchTaipeiTemp(): Promise<number> {
  const apiKey = process.env.OPENWEATHER_API_KEY ?? process.env.VITE_OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error("OPENWEATHER_API_KEY is not set; mock temperatures are not allowed");
  const r = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?lat=25.033&lon=121.5654&appid=${apiKey}&units=metric`,
  );
  const j = (await r.json()) as any;
  const t = j?.main?.temp;
  if (typeof t !== "number") throw new Error(`OpenWeather response has no temp: ${JSON.stringify(j).slice(0,200)}`);
  return t;
}
const BET_AMOUNT = parseUnits("0.5", 6); // 0.5 USDC
const FUND_B = parseUnits("3", 6);       // 3 USDC for B (the native balance is also gas)

async function main() {
  const { key, chain, deploymentFile } = resolveNetwork();
  if (key !== "arc-testnet") throw new Error("this script only runs against arc-testnet");

  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, `../deployments/${deploymentFile}`), "utf-8"),
  );
  const WM = deployments.contracts.WeatherMarket as Address;
  const AO = deployments.contracts.AdminOracle as Address;
  const USDC = deployments.contracts.USDC as Address;

  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
  const aoArt = await hre.artifacts.readArtifact("AdminOracle");

  const { account: A, walletClient: walletA, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);

  // Wallet B: reuse E2E_WALLET_B_KEY, or generate one and append it to .env.e2e (gitignored)
  let bKey = process.env.E2E_WALLET_B_KEY as Hex | undefined;
  if (!bKey) {
    bKey = generatePrivateKey();
    appendFileSync(resolve(__dirname, "../.env.e2e"), `E2E_WALLET_B_KEY=${bKey}\n`);
    rec(`> Generated a fresh test wallet B; its key was written to .env.e2e (covered by the .env* rule in .gitignore)`);
  }
  const B = privateKeyToAccount(bKey);
  const walletB = createWalletClient({ account: B, chain, transport: http() });

  const fees = await computeFees(publicClient);

  rec(`# Arc Testnet E2E — ${new Date().toISOString()}`);
  rec(``);
  rec(`| Field | Value |`);
  rec(`|---|---|`);
  rec(`| Network | ${chain.name} (chainId ${chain.id}) |`);
  rec(`| WeatherMarket | \`${WM}\` |`);
  rec(`| AdminOracle | \`${AO}\` |`);
  rec(`| Wallet A (owner) | \`${A.address}\` |`);
  rec(`| Wallet B (ordinary user) | \`${B.address}\` |`);
  rec(`| Gas | ${fees.source} — ${fees.detail} |`);
  rec(``);

  const gasOpts = {
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };

  async function confirm(hash: Hex, label: string) {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} revert: ${hash}`);
    rec(`- ${label} → \`${hash}\` (block ${r.blockNumber}, gasUsed ${r.gasUsed})`);
    return r;
  }

  const usdcBal = async (a: Address) =>
    (await publicClient.readContract({
      address: USDC, abi: wmArt.abi as any, functionName: "balanceOf", args: [a],
    } as any).catch(async () =>
      publicClient.readContract({
        address: USDC,
        abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as any,
        functionName: "balanceOf", args: [a],
      } as any),
    )) as bigint;

  // ── 0. Confirm owner / non-owner ───────────────────────────────────────
  rec(`## 0. Permission preconditions`);
  const owner = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "owner",
  } as any)) as Address;
  rec(`- \`WeatherMarket.owner()\` = \`${owner}\``);
  rec(`- Wallet A is the owner: **${owner.toLowerCase() === A.address.toLowerCase()}**`);
  rec(`- Wallet B is the owner: **${owner.toLowerCase() === B.address.toLowerCase()}**`);
  rec(``);

  // ── 1. Fund wallet B ───────────────────────────────────────────────────
  rec(`## 1. Funding wallet B`);
  const bBefore = await publicClient.getBalance({ address: B.address });
  rec(`- B native balance (= USDC, Arc's native gas token): ${formatUnits(bBefore, 18)}`);
  if (bBefore < parseUnits("1", 18)) {
    const h = await walletA.sendTransaction({
      account: A, chain, to: B.address,
      value: parseUnits(formatUnits(FUND_B, 6), 18),
      ...gasOpts,
    } as never);
    await confirm(h, `A -> B transfer of ${formatUnits(FUND_B, 6)} USDC`);
  } else {
    rec(`- Balance sufficient, transfer skipped`);
  }
  rec(`- B balance (after): ${formatUnits(await publicClient.getBalance({ address: B.address }), 18)}`);
  rec(``);

  // ── 2. onlyOwner functions must reject a non-owner ─────────────────────
  rec(`## 2. Non-owner permission boundary (measured on-chain)`);
  const nowTs = () => Math.floor(Date.now() / 1000);
  for (const [label, call] of [
    ["createMarket (5-arg)", { functionName: "createMarket", args: ["Taipei", BigInt(nowTs() + 7200), BUCKETS, BigInt(nowTs() + 3600), BigInt(M1_LOCKED_TIMEOUT)] }],
    ["setDefaultLockedTimeout", { functionName: "setDefaultLockedTimeout", args: [BigInt(7 * 86400)] }],
    ["withdrawFees", { functionName: "withdrawFees", args: [] }],
  ] as const) {
    try {
      await publicClient.simulateContract({
        account: B.address, address: WM, abi: wmArt.abi as any,
        functionName: (call as any).functionName, args: (call as any).args,
      } as any);
      rec(`- ❌ \`${label}\` called by B unexpectedly simulated successfully — permissions are wrong`);
    } catch (err) {
      const m = (err as any).shortMessage ?? (err as any).message ?? String(err);
      rec(`- ✅ \`${label}\` called by B is rejected: \`${String(m).split("\n")[0].slice(0, 90)}\``);
    }
  }
  rec(``);

  // ── 3. M1: settlement path ─────────────────────────────────────────────
  rec(`## 3. M1 settlement path`);
  const m1Lock = BigInt(nowTs() + M1_LOCK_DELAY);
  const m1Target = m1Lock + 3600n;
  const idBefore = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "nextMarketId",
  } as any)) as bigint;

  const h1 = await walletA.writeContract({
    account: A, chain, address: WM, abi: wmArt.abi as any,
    functionName: "createMarket",
    args: ["Taipei", m1Target, BUCKETS, m1Lock, BigInt(M1_LOCKED_TIMEOUT)],
    gas: 400_000n, ...gasOpts,
  } as never);
  await confirm(h1, `createMarket M1 (#${idBefore})`);
  const M1 = idBefore;

  let m = await readMarket(publicClient, WM, wmArt.abi, M1);
  const m1Deadline = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "settlementDeadline", args: [M1],
  } as any)) as bigint;
  const m1Timeout = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "marketLockedTimeout", args: [M1],
  } as any)) as bigint;
  rec(`- getMarket(#${M1}): city=\`${m.city}\` lockTime=${m.lockTime} targetDate=${m.targetDate} status=${STATUS_LABEL[m.status]} buckets=[${m.buckets.join(",")}]`);
  rec(`- marketLockedTimeout=${m1Timeout} settlementDeadline=${m1Deadline} (= lockTime + ${m1Timeout})`);

  // B places a bet
  const approveAbi = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;
  const ha = await walletB.writeContract({
    account: B, chain, address: USDC, abi: approveAbi,
    functionName: "approve", args: [WM, BET_AMOUNT * 10n], gas: 120_000n, ...gasOpts,
  } as never);
  await confirm(ha, `B approve USDC`);

  // M1_BUCKET=auto (the default) reads the current real temperature first so B bets on
  // the bucket that will win, which is what actually exercises the "has a winner and the
  // 2% fee is charged" path. M1_BUCKET=<n> forces a specific bucket, used to exercise
  // noWinner.
  const preTemp = await fetchTaipeiTemp();
  const forced = process.env.M1_BUCKET;
  const betBucket =
    forced && forced !== "auto" ? Number(forced) : bucketFor(Math.round(preTemp));
  rec(`- Real temperature fetched before betting: **${preTemp}°C** -> round ${Math.round(preTemp)} -> maps to bucket **${bucketFor(Math.round(preTemp))}**; B bets bucket **${betBucket}**`);

  const hb = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "placeBet", args: [M1, betBucket, BET_AMOUNT], gas: 300_000n, ...gasOpts,
  } as never);
  await confirm(hb, `B placeBet(#${M1}, bucket ${betBucket}, ${formatUnits(BET_AMOUNT, 6)} USDC)`);

  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- totalPool=${formatUnits(m.totalPool, 6)} USDC，bucketTotals[${betBucket}]=${formatUnits((await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "bucketTotals", args: [M1, betBucket] } as any)) as bigint, 6)}`);

  // Wait for lockTime
  const waitFor = Number(m1Lock) - nowTs() + 5;
  rec(`- Waiting for lockTime (${waitFor}s)…`);
  if (waitFor > 0) await sleep(waitFor * 1000);

  // B (a non-owner) locks the market — lockMarket is permissionless
  const hl = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "lockMarket", args: [M1], gas: 150_000n, ...gasOpts,
  } as never);
  await confirm(hl, `B lockMarket(#${M1}) (permissionless — callable by a non-owner)`);
  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- status → **${STATUS_LABEL[m.status]}**`);

  // Real temperature
  const rawTemp = await fetchTaipeiTemp();
  const rounded = Math.round(rawTemp);
  rec(`- OpenWeather Taipei raw temperature **${rawTemp}°C** -> Math.round -> submitted on-chain **${rounded}**`);

  const hs = await walletA.writeContract({
    account: A, chain, address: AO, abi: aoArt.abi as any,
    functionName: "submitResult", args: [m.city, BigInt(rounded), M1],
    gas: 400_000n, ...gasOpts,
  } as never);
  await confirm(hs, `A AdminOracle.submitResult("${m.city}", ${rounded}, ${M1})`);

  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- getMarket(#${M1}) read back: status=**${STATUS_LABEL[m.status]}** finalTemp=**${m.finalTemp}** winningBucket=**${m.winningBucket}** noWinner=**${m.noWinner}**`);
  rec(`- Three-way consistency check: raw ${rawTemp} -> rounded ${rounded} -> on-chain finalTemp ${m.finalTemp} -> **${BigInt(rounded) === m.finalTemp ? "consistent ✅" : "inconsistent ❌"}**`);

  const feesAfter = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "collectedFees",
  } as any)) as bigint;

  // B claims
  const bBal0 = await usdcBal(B.address);
  if (!m.noWinner && m.winningBucket === betBucket) {
    const hc = await walletB.writeContract({
      account: B, chain, address: WM, abi: wmArt.abi as any,
      functionName: "claimWinnings", args: [M1], gas: 300_000n, ...gasOpts,
    } as never);
    const cr = await confirm(hc, `B claimWinnings(#${M1})`);
    const bBal1 = await usdcBal(B.address);
    const gasCost = cr.gasUsed * cr.effectiveGasPrice;
    const netDelta = bBal1 - bBal0 + gasCost / 1_000_000_000_000n;
    rec(`- B USDC before ${formatUnits(bBal0, 6)} -> after ${formatUnits(bBal1, 6)} (gas ${formatUnits(gasCost / 1_000_000_000_000n, 6)})`);
    rec(`- Net received after gas ≈ ${formatUnits(netDelta, 6)} USDC; pool ${formatUnits(m.totalPool, 6)} - 2% fee ${formatUnits(feesAfter, 6)} = ${formatUnits(m.totalPool - feesAfter, 6)}`);
  } else {
    rec(`- ⚠ Actual temperature ${rounded}°C falls in bucket ${m.winningBucket} (B bet bucket ${betBucket}), noWinner=${m.noWinner}`);
    if (m.noWinner) {
      const hc = await walletB.writeContract({
        account: B, chain, address: WM, abi: wmArt.abi as any,
        functionName: "claimWinnings", args: [M1], gas: 300_000n, ...gasOpts,
      } as never);
      await confirm(hc, `B claimWinnings(#${M1}) (noWinner -> full refund)`);
      rec(`- B USDC before ${formatUnits(bBal0, 6)} -> after ${formatUnits(await usdcBal(B.address), 6)}`);
    }
  }
  rec(`- collectedFees = **${formatUnits(feesAfter, 6)} USDC**（= totalPool ${formatUnits(m.totalPool, 6)} × 2%）`);

  if (feesAfter > 0n) {
    const aBal0 = await usdcBal(A.address);
    const hw = await walletA.writeContract({
      account: A, chain, address: WM, abi: wmArt.abi as any,
      functionName: "withdrawFees", args: [], gas: 200_000n, ...gasOpts,
    } as never);
    await confirm(hw, `A withdrawFees()`);
    const aBal1 = await usdcBal(A.address);
    rec(`- A USDC before ${formatUnits(aBal0, 6)} -> after ${formatUnits(aBal1, 6)}`);
    rec(`- collectedFees zeroed check: ${formatUnits((await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "collectedFees" } as any)) as bigint, 6)}`);
  } else {
    rec(`- (noWinner path: fee waived, nothing for withdrawFees to move)`);
  }
  rec(``);

  // ── 4. M2: refund path, taken to the waiting state ─────────────────────
  rec(`## 4. M2 refund path (claimRefund becomes available after 24h)`);
  const m2Lock = BigInt(nowTs() + M2_LOCK_DELAY);
  const idB = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "nextMarketId",
  } as any)) as bigint;
  const h2 = await walletA.writeContract({
    account: A, chain, address: WM, abi: wmArt.abi as any,
    functionName: "createMarket",
    args: ["Tokyo", m2Lock + 3600n, BUCKETS, m2Lock, BigInt(M2_LOCKED_TIMEOUT)],
    gas: 400_000n, ...gasOpts,
  } as never);
  await confirm(h2, `createMarket M2 (#${idB})，lockedTimeout=${M2_LOCKED_TIMEOUT}s (MIN)`);
  const M2 = idB;

  const hb2 = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "placeBet", args: [M2, 1, BET_AMOUNT], gas: 300_000n, ...gasOpts,
  } as never);
  await confirm(hb2, `B placeBet(#${M2}, bucket 1, ${formatUnits(BET_AMOUNT, 6)} USDC)`);

  const wait2 = Number(m2Lock) - nowTs() + 5;
  rec(`- Waiting for lockTime (${wait2}s)…`);
  if (wait2 > 0) await sleep(wait2 * 1000);

  const hl2 = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "lockMarket", args: [M2], gas: 150_000n, ...gasOpts,
  } as never);
  await confirm(hl2, `B lockMarket(#${M2})`);

  const m2 = await readMarket(publicClient, WM, wmArt.abi, M2);
  const m2Deadline = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "settlementDeadline", args: [M2],
  } as any)) as bigint;
  rec(`- status=**${STATUS_LABEL[m2.status]}** settlementDeadline=**${m2Deadline}** (${new Date(Number(m2Deadline) * 1000).toISOString()})`);
  rec(`- claimRefund should revert right now (window not open):`);
  try {
    await publicClient.simulateContract({
      account: B.address, address: WM, abi: wmArt.abi as any,
      functionName: "claimRefund", args: [M2],
    } as any);
    rec(`  - ❌ the simulation unexpectedly succeeded`);
  } catch (err) {
    rec(`  - ✅ \`${String((err as any).shortMessage ?? (err as any).message).split("\n")[0].slice(0, 100)}\``);
  }
  rec(`- submitResult would succeed right now (still inside the window) but is deliberately **not executed**, leaving the refund path to be tested after 24h`);
  rec(``);
  rec(`> **TODO**: after ${new Date(Number(m2Deadline) * 1000).toISOString()}, call \`claimRefund\` on #${M2} from wallet B,`);
  rec(`> expecting the full principal of ${formatUnits(BET_AMOUNT, 6)} USDC back (no 2% fee deducted).`);

  writeFileSync(LOG_PATH, log.join("\n") + "\n");
  console.log(`\n✓ log written to ${LOG_PATH}`);
  console.log(`\nM1=#${M1}  M2=#${M2}  walletB=${B.address}`);
}

main().catch((err) => {
  writeFileSync(LOG_PATH, log.join("\n") + `\n\n**Aborted**: ${err.shortMessage ?? err.message}\n`);
  console.error("E2E failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
