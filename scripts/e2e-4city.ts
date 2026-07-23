import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  decodeEventLog,
  maxUint256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] } },
});

const GAS_OPTS = {
  gas: 500_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

const CITIES = ["Taipei", "Tokyo", "Seoul", "Bangkok"];
const BUCKETS: bigint[] = [25n, 28n, 31n, 34n]; // bucket 3 (31–34] wins at 32°C
const FIXED_TEMP = 32n;                          // temp=32 → bucket 3 wins, noWinner=true (nobody bet bucket 3) → refund
const LOCK_DELAY  = 90;                          // 秒
const TARGET_DELAY = 180;                        // 秒
const USDC_DECIMALS = 6n;
const e6 = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function waitUntil(targetSec: number, label: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const delay = targetSec - now;
  if (delay > 0) {
    console.log(`  ⏳ 等待 ${delay}s 直到 ${label}...`);
    await new Promise((r) => setTimeout(r, delay * 1000 + 2_000)); // 多等 2s buffer
  }
}

interface CityResult {
  city: string;
  marketId: string;
  createTx: string;
  approveTx?: string;
  bet1Tx: string;
  bet2Tx: string;
  lockTx: string;
  submitTx: string;
  claimTx: string;
  temp: string;
  claimedAmount: string;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );

  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const adminOracleAddr   = deployments.contracts.AdminOracle   as Hex;
  const usdcAddr          = deployments.contracts.USDC          as Hex;

  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");
  const aoArt = await hre.artifacts.readArtifact("AdminOracle");

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient  = createPublicClient({ chain: arc, transport: http() });

  console.log("=".repeat(60));
  console.log("Presage — 4 城市 E2E 測試");
  console.log("  帳戶     :", account.address);
  console.log("  lockDelay:", LOCK_DELAY, "s");
  console.log("  溫度     :", FIXED_TEMP.toString(), "°C");
  console.log("=".repeat(60));

  // USDC 餘額確認
  const usdcBal = (await publicClient.readContract({
    address: usdcAddr, abi: erc20Abi,
    functionName: "balanceOf", args: [account.address],
  })) as bigint;
  console.log(`USDC 餘額 : ${(Number(usdcBal) / 1e6).toFixed(2)} USDC`);
  if (usdcBal < e6(8)) {
    throw new Error(`USDC 不足，4 個城市共需至少 8 USDC，目前 ${Number(usdcBal) / 1e6} USDC`);
  }

  const results: CityResult[] = [];

  for (let idx = 0; idx < CITIES.length; idx++) {
    const city = CITIES[idx];
    const isFirst = idx === 0;

    console.log("\n" + "─".repeat(60));
    console.log(`【${city}】開始 (${idx + 1}/${CITIES.length})`);
    console.log("─".repeat(60));

    const now = Math.floor(Date.now() / 1000);
    const lockTime   = now + LOCK_DELAY;
    const targetDate = now + TARGET_DELAY;

    // ── Step 1: createMarket ────────────────────────────────────────────────
    console.log("\n[Step 1] createMarket");
    console.log("  buckets  :", `[${BUCKETS.join(",")}]`);
    console.log("  lockTime :", new Date(lockTime * 1000).toISOString());

    const createHash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: wmArt.abi,
      functionName: "createMarket",
      args: [city, BigInt(targetDate), BUCKETS, BigInt(lockTime)],
      ...GAS_OPTS,
    });
    console.log("  tx hash  :", createHash);
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

    let marketId: bigint | null = null;
    for (const log of createReceipt.logs) {
      try {
        const d = decodeEventLog({ abi: wmArt.abi, data: log.data, topics: log.topics, eventName: "MarketCreated" });
        marketId = (d.args as { marketId: bigint }).marketId;
        break;
      } catch { /* skip */ }
    }
    if (marketId === null) throw new Error("無法解析 marketId");
    console.log("  marketId :", marketId.toString());
    console.log("  ✓ createMarket 確認");

    // ── Step 2: approve（第一個城市才做）──────────────────────────────────────
    let approveTx: string | undefined;
    if (isFirst) {
      console.log("\n[Step 2] approve USDC (maxUint256)");
      const ah = await walletClient.writeContract({
        address: usdcAddr, abi: erc20Abi,
        functionName: "approve", args: [weatherMarketAddr, maxUint256],
        ...GAS_OPTS,
      });
      console.log("  tx hash  :", ah);
      await publicClient.waitForTransactionReceipt({ hash: ah });
      approveTx = ah;
      console.log("  ✓ Approve 確認");
    } else {
      console.log("\n[Step 2] approve USDC — 跳過（已在第一個城市完成）");
    }

    // ── Step 3: placeBet x2 ─────────────────────────────────────────────────
    console.log("\n[Step 3] placeBet × 2");

    console.log("  Bet 1: bucket 1 (25<temp≤28), 1 USDC");
    const bet1Hash = await walletClient.writeContract({
      address: weatherMarketAddr, abi: wmArt.abi,
      functionName: "placeBet", args: [marketId, 1, e6(1)],
      ...GAS_OPTS,
    });
    console.log("  tx hash  :", bet1Hash);
    await publicClient.waitForTransactionReceipt({ hash: bet1Hash });
    console.log("  ✓ Bet 1 確認");

    console.log("  Bet 2: bucket 2 (28<temp≤31), 1 USDC");
    const bet2Hash = await walletClient.writeContract({
      address: weatherMarketAddr, abi: wmArt.abi,
      functionName: "placeBet", args: [marketId, 2, e6(1)],
      ...GAS_OPTS,
    });
    console.log("  tx hash  :", bet2Hash);
    await publicClient.waitForTransactionReceipt({ hash: bet2Hash });
    console.log("  ✓ Bet 2 確認");

    // ── Step 4: 等待 lockTime → lockMarket ─────────────────────────────────
    console.log("\n[Step 4] lockMarket");
    await waitUntil(lockTime, "lockTime");

    const lockHash = await walletClient.writeContract({
      address: weatherMarketAddr, abi: wmArt.abi,
      functionName: "lockMarket", args: [marketId],
      gas: 100_000n, maxPriorityFeePerGas: parseGwei("10"), maxFeePerGas: parseGwei("100"),
    });
    console.log("  tx hash  :", lockHash);
    await publicClient.waitForTransactionReceipt({ hash: lockHash });
    console.log("  ✓ 市場已鎖盤");

    // ── Step 5: submitResult（32°C → bucket 3 wins, noWinner=true → 全額退款）
    console.log(`\n[Step 5] submitResult  temp=${FIXED_TEMP}°C`);
    console.log("  ℹ️  bucket 3 (31<temp≤34) 獲勝，但我們下注 bucket 1 & 2 → noWinner=true → 全額退款");

    const submitHash = await walletClient.writeContract({
      address: adminOracleAddr, abi: aoArt.abi,
      functionName: "submitResult", args: [city, FIXED_TEMP, marketId],
      gas: 300_000n, maxPriorityFeePerGas: parseGwei("10"), maxFeePerGas: parseGwei("100"),
    });
    console.log("  tx hash  :", submitHash);
    await publicClient.waitForTransactionReceipt({ hash: submitHash });
    console.log("  ✓ 結果提交確認");

    // ── Step 6: claimWinnings ───────────────────────────────────────────────
    console.log("\n[Step 6] claimWinnings");

    const claimHash = await walletClient.writeContract({
      address: weatherMarketAddr, abi: wmArt.abi,
      functionName: "claimWinnings", args: [marketId],
      gas: 150_000n, maxPriorityFeePerGas: parseGwei("10"), maxFeePerGas: parseGwei("100"),
    });
    console.log("  tx hash  :", claimHash);
    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });

    let payout = 0n;
    for (const log of claimReceipt.logs) {
      if (log.address.toLowerCase() !== weatherMarketAddr.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: wmArt.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (d.eventName === "WinningsClaimed") {
          payout = (d.args as { amount: bigint }).amount;
        }
      } catch { /* skip */ }
    }
    const payoutStr = payout > 0n ? `${(Number(payout) / 1e6).toFixed(6)} USDC` : "(請查 tx)";
    console.log(`  ✓ Claim 成功 → 領回 ${payoutStr}`);

    results.push({
      city,
      marketId: marketId.toString(),
      createTx:  createHash,
      approveTx,
      bet1Tx:    bet1Hash,
      bet2Tx:    bet2Hash,
      lockTx:    lockHash,
      submitTx:  submitHash,
      claimTx:   claimHash,
      temp:      FIXED_TEMP.toString() + "°C",
      claimedAmount: payoutStr,
    });
  } // end for

  // ── 最終報告 ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("E2E 完成報告");
  console.log("=".repeat(60));

  let totalTx = 0;
  for (const r of results) {
    console.log(`\n▶ ${r.city}  (marketId: ${r.marketId})`);
    if (r.approveTx) { console.log(`  [approve]      ${r.approveTx}`); totalTx++; }
    console.log(`  [createMarket] ${r.createTx}`);      totalTx++;
    console.log(`  [bet 1]        ${r.bet1Tx}`);         totalTx++;
    console.log(`  [bet 2]        ${r.bet2Tx}`);         totalTx++;
    console.log(`  [lockMarket]   ${r.lockTx}`);         totalTx++;
    console.log(`  [submitResult] ${r.submitTx}  (${r.temp})`); totalTx++;
    console.log(`  [claim]        ${r.claimTx}  → ${r.claimedAmount}`); totalTx++;
  }

  console.log("\n" + "─".repeat(60));
  console.log(`總 tx 數：${totalTx}`);
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
