/**
 * Arc Testnet 端對端驗證（真實鏈上交易，不使用任何 mock）。
 *
 * 兩個錢包：
 *   A = dev 錢包（WeatherMarket / AdminOracle 的 owner）
 *   B = 一般使用者錢包（非 owner），用來下注與領取
 *
 * 產生兩個市場：
 *   M1 結算路徑：建市 → B 下注 → B 鎖盤（permissionless）→ A 提交真實氣溫 → B 領獎
 *   M2 退款路徑：建市（lockedTimeout = MIN_LOCKED_TIMEOUT = 1 天）→ B 下注 → 鎖盤
 *                → 24 小時後才能 claimRefund，本腳本只負責建到「等待中」狀態
 *
 * 用法：
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

// M1 用短鎖盤期，讓結算路徑可以在單一 session 內跑完。
// admin 面板下拉的最小值是 24 小時，這裡刻意走合約層的下限以壓縮驗證時間，
// 差異已在報告中標明。
const M1_LOCK_DELAY = 150;        // 秒
const M1_LOCKED_TIMEOUT = 86_400; // MIN_LOCKED_TIMEOUT
const M2_LOCK_DELAY = 90;
const M2_LOCKED_TIMEOUT = 86_400;

const BUCKETS = [25n, 28n, 31n, 34n];

// 依規格決定某個溫度落在哪個 bucket（與合約 _determineWinningBucket 同義）
function bucketFor(temp: number): number {
  for (let i = 0; i < BUCKETS.length; i++) if (BigInt(temp) <= BUCKETS[i]) return i;
  return BUCKETS.length;
}

async function fetchTaipeiTemp(): Promise<number> {
  const apiKey = process.env.OPENWEATHER_API_KEY ?? process.env.VITE_OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error("OPENWEATHER_API_KEY 未設定，禁止用 mock 溫度");
  const r = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?lat=25.033&lon=121.5654&appid=${apiKey}&units=metric`,
  );
  const j = (await r.json()) as any;
  const t = j?.main?.temp;
  if (typeof t !== "number") throw new Error(`OpenWeather 回應無 temp：${JSON.stringify(j).slice(0,200)}`);
  return t;
}
const BET_AMOUNT = parseUnits("0.5", 6); // 0.5 USDC
const FUND_B = parseUnits("3", 6);       // 給 B 3 USDC（原生餘額同時就是 gas）

async function main() {
  const { key, chain, deploymentFile } = resolveNetwork();
  if (key !== "arc-testnet") throw new Error("這支腳本只在 arc-testnet 上跑");

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

  // 錢包 B：固定用 E2E_WALLET_B_KEY，沒有就產一把並寫回 .env.e2e（不進 git）
  let bKey = process.env.E2E_WALLET_B_KEY as Hex | undefined;
  if (!bKey) {
    bKey = generatePrivateKey();
    appendFileSync(resolve(__dirname, "../.env.e2e"), `E2E_WALLET_B_KEY=${bKey}\n`);
    rec(`> 產生新的測試錢包 B，私鑰已寫入 .env.e2e（已被 .gitignore 的 .env* 規則涵蓋）`);
  }
  const B = privateKeyToAccount(bKey);
  const walletB = createWalletClient({ account: B, chain, transport: http() });

  const fees = await computeFees(publicClient);

  rec(`# Arc Testnet E2E — ${new Date().toISOString()}`);
  rec(``);
  rec(`| 項目 | 值 |`);
  rec(`|---|---|`);
  rec(`| 網路 | ${chain.name} (chainId ${chain.id}) |`);
  rec(`| WeatherMarket | \`${WM}\` |`);
  rec(`| AdminOracle | \`${AO}\` |`);
  rec(`| 錢包 A (owner) | \`${A.address}\` |`);
  rec(`| 錢包 B (一般使用者) | \`${B.address}\` |`);
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

  // ── 0. 確認 owner / 非 owner ────────────────────────────────────────────
  rec(`## 0. 權限前提確認`);
  const owner = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "owner",
  } as any)) as Address;
  rec(`- \`WeatherMarket.owner()\` = \`${owner}\``);
  rec(`- 錢包 A 是 owner：**${owner.toLowerCase() === A.address.toLowerCase()}**`);
  rec(`- 錢包 B 是 owner：**${owner.toLowerCase() === B.address.toLowerCase()}**`);
  rec(``);

  // ── 1. 資金錢包 B ───────────────────────────────────────────────────────
  rec(`## 1. 資助錢包 B`);
  const bBefore = await publicClient.getBalance({ address: B.address });
  rec(`- B 原生餘額（= USDC，Arc 原生 gas 代幣）: ${formatUnits(bBefore, 18)}`);
  if (bBefore < parseUnits("1", 18)) {
    const h = await walletA.sendTransaction({
      account: A, chain, to: B.address,
      value: parseUnits(formatUnits(FUND_B, 6), 18),
      ...gasOpts,
    } as never);
    await confirm(h, `A → B 轉帳 ${formatUnits(FUND_B, 6)} USDC`);
  } else {
    rec(`- 餘額足夠，跳過轉帳`);
  }
  rec(`- B 餘額（後）: ${formatUnits(await publicClient.getBalance({ address: B.address }), 18)}`);
  rec(``);

  // ── 2. 非 owner 呼叫 onlyOwner 函式必須被擋 ─────────────────────────────
  rec(`## 2. 非 owner 的權限邊界（鏈上實測）`);
  const nowTs = () => Math.floor(Date.now() / 1000);
  for (const [label, call] of [
    ["createMarket (5 參數)", { functionName: "createMarket", args: ["Taipei", BigInt(nowTs() + 7200), BUCKETS, BigInt(nowTs() + 3600), BigInt(M1_LOCKED_TIMEOUT)] }],
    ["setDefaultLockedTimeout", { functionName: "setDefaultLockedTimeout", args: [BigInt(7 * 86400)] }],
    ["withdrawFees", { functionName: "withdrawFees", args: [] }],
  ] as const) {
    try {
      await publicClient.simulateContract({
        account: B.address, address: WM, abi: wmArt.abi as any,
        functionName: (call as any).functionName, args: (call as any).args,
      } as any);
      rec(`- ❌ \`${label}\` 由 B 呼叫竟然模擬成功 —— 權限有問題`);
    } catch (err) {
      const m = (err as any).shortMessage ?? (err as any).message ?? String(err);
      rec(`- ✅ \`${label}\` 由 B 呼叫被擋：\`${String(m).split("\n")[0].slice(0, 90)}\``);
    }
  }
  rec(``);

  // ── 3. M1：結算路徑 ─────────────────────────────────────────────────────
  rec(`## 3. M1 結算路徑`);
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

  // B 下注
  const approveAbi = [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }] as const;
  const ha = await walletB.writeContract({
    account: B, chain, address: USDC, abi: approveAbi,
    functionName: "approve", args: [WM, BET_AMOUNT * 10n], gas: 120_000n, ...gasOpts,
  } as never);
  await confirm(ha, `B approve USDC`);

  // M1_BUCKET=auto（預設）→ 先查目前真實氣溫，讓 B 押在「會贏」的 bucket，
  // 這樣才能真的驗到「有得獎者 + 收 2% 手續費」那條路徑。
  // M1_BUCKET=<n> 可強制指定，用來驗 noWinner。
  const preTemp = await fetchTaipeiTemp();
  const forced = process.env.M1_BUCKET;
  const betBucket =
    forced && forced !== "auto" ? Number(forced) : bucketFor(Math.round(preTemp));
  rec(`- 下注前查真實氣溫：**${preTemp}°C** → round ${Math.round(preTemp)} → 對應 bucket **${bucketFor(Math.round(preTemp))}**；B 押 bucket **${betBucket}**`);

  const hb = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "placeBet", args: [M1, betBucket, BET_AMOUNT], gas: 300_000n, ...gasOpts,
  } as never);
  await confirm(hb, `B placeBet(#${M1}, bucket ${betBucket}, ${formatUnits(BET_AMOUNT, 6)} USDC)`);

  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- totalPool=${formatUnits(m.totalPool, 6)} USDC，bucketTotals[${betBucket}]=${formatUnits((await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "bucketTotals", args: [M1, betBucket] } as any)) as bigint, 6)}`);

  // 等 lockTime
  const waitFor = Number(m1Lock) - nowTs() + 5;
  rec(`- 等待 lockTime（${waitFor}s）…`);
  if (waitFor > 0) await sleep(waitFor * 1000);

  // B（非 owner）鎖盤 —— lockMarket 是 permissionless
  const hl = await walletB.writeContract({
    account: B, chain, address: WM, abi: wmArt.abi as any,
    functionName: "lockMarket", args: [M1], gas: 150_000n, ...gasOpts,
  } as never);
  await confirm(hl, `B lockMarket(#${M1})（permissionless，非 owner 可呼叫）`);
  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- status → **${STATUS_LABEL[m.status]}**`);

  // 真實氣溫
  const rawTemp = await fetchTaipeiTemp();
  const rounded = Math.round(rawTemp);
  rec(`- OpenWeather Taipei 原始溫度 **${rawTemp}°C** → Math.round → 送上鏈 **${rounded}**`);

  const hs = await walletA.writeContract({
    account: A, chain, address: AO, abi: aoArt.abi as any,
    functionName: "submitResult", args: [m.city, BigInt(rounded), M1],
    gas: 400_000n, ...gasOpts,
  } as never);
  await confirm(hs, `A AdminOracle.submitResult("${m.city}", ${rounded}, ${M1})`);

  m = await readMarket(publicClient, WM, wmArt.abi, M1);
  rec(`- getMarket(#${M1}) 回讀：status=**${STATUS_LABEL[m.status]}** finalTemp=**${m.finalTemp}** winningBucket=**${m.winningBucket}** noWinner=**${m.noWinner}**`);
  rec(`- 三者一致檢查：原始 ${rawTemp} → 四捨五入 ${rounded} → 鏈上 finalTemp ${m.finalTemp} → **${BigInt(rounded) === m.finalTemp ? "一致 ✅" : "不一致 ❌"}**`);

  const feesAfter = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "collectedFees",
  } as any)) as bigint;

  // B 領取
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
    rec(`- B USDC 前 ${formatUnits(bBal0, 6)} → 後 ${formatUnits(bBal1, 6)}（扣掉 gas ${formatUnits(gasCost / 1_000_000_000_000n, 6)}）`);
    rec(`- 扣除 gas 後的實得 ≈ ${formatUnits(netDelta, 6)} USDC；池 ${formatUnits(m.totalPool, 6)} - 2% 手續費 ${formatUnits(feesAfter, 6)} = ${formatUnits(m.totalPool - feesAfter, 6)}`);
  } else {
    rec(`- ⚠ 實際氣溫 ${rounded}°C 落在 bucket ${m.winningBucket}（B 押的是 bucket ${betBucket}），noWinner=${m.noWinner}`);
    if (m.noWinner) {
      const hc = await walletB.writeContract({
        account: B, chain, address: WM, abi: wmArt.abi as any,
        functionName: "claimWinnings", args: [M1], gas: 300_000n, ...gasOpts,
      } as never);
      await confirm(hc, `B claimWinnings(#${M1})（noWinner → 全額退款）`);
      rec(`- B USDC 前 ${formatUnits(bBal0, 6)} → 後 ${formatUnits(await usdcBal(B.address), 6)}`);
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
    rec(`- A USDC 前 ${formatUnits(aBal0, 6)} → 後 ${formatUnits(aBal1, 6)}`);
    rec(`- collectedFees 歸零檢查：${formatUnits((await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "collectedFees" } as any)) as bigint, 6)}`);
  } else {
    rec(`- （noWinner 路徑，手續費豁免，無 withdrawFees 可測）`);
  }
  rec(``);

  // ── 4. M2：退款路徑（建到等待中狀態）──────────────────────────────────
  rec(`## 4. M2 退款路徑（等待 24h 後可 claimRefund）`);
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
  rec(`- 等待 lockTime（${wait2}s）…`);
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
  rec(`- 現在 claimRefund 應該要 revert（窗口未開）：`);
  try {
    await publicClient.simulateContract({
      account: B.address, address: WM, abi: wmArt.abi as any,
      functionName: "claimRefund", args: [M2],
    } as any);
    rec(`  - ❌ 竟然模擬成功`);
  } catch (err) {
    rec(`  - ✅ \`${String((err as any).shortMessage ?? (err as any).message).split("\n")[0].slice(0, 100)}\``);
  }
  rec(`- 現在 submitResult 應該要成功（窗口內），但刻意**不執行**，留給 24h 後測退款`);
  rec(``);
  rec(`> **待辦**：${new Date(Number(m2Deadline) * 1000).toISOString()} 之後，用錢包 B 對 #${M2} 呼叫 \`claimRefund\`，`);
  rec(`> 預期取回本金全額 ${formatUnits(BET_AMOUNT, 6)} USDC（不扣 2% 手續費）。`);

  writeFileSync(LOG_PATH, log.join("\n") + "\n");
  console.log(`\n✓ 記錄已寫入 ${LOG_PATH}`);
  console.log(`\nM1=#${M1}  M2=#${M2}  錢包B=${B.address}`);
}

main().catch((err) => {
  writeFileSync(LOG_PATH, log.join("\n") + `\n\n**中止**：${err.shortMessage ?? err.message}\n`);
  console.error("E2E failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
