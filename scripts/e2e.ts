/**
 * Arc Testnet 完整 e2e 測試腳本
 *
 * 流程：建市場 → 下注 → 等候鎖倉 → lockMarket → AdminOracle.submitResult → claimWinnings
 *
 * 執行方式：
 *   npx hardhat run scripts/e2e.ts --network arc
 */
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

// ─── 鏈設定 ────────────────────────────────────────────────────────────────────
const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const GAS_OPTS = {
  gas: 500_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"] as const;
const USDC_DECIMALS = 6n;
const e6 = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

// ─── 等待工具 ──────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(targetTs: number, label: string) {
  const now = Math.floor(Date.now() / 1000);
  const remaining = targetTs - now;
  if (remaining <= 0) return;
  console.log(`  ⏳ 等待 ${remaining} 秒 (${label})...`);
  for (let i = remaining; i > 0; i -= 5) {
    process.stdout.write(`\r  剩餘 ${i} 秒  `);
    await sleep(Math.min(5000, i * 1000));
  }
  console.log("\r  ✓ 時間到！       ");
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  // ── 讀取合約地址和 ABI ──────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const adminOracleAddr = deployments.contracts.AdminOracle as Hex;
  const usdcAddr = deployments.contracts.USDC as Hex;

  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const aoArtifact = await hre.artifacts.readArtifact("AdminOracle");

  // 最小 ERC-20 ABI（approve + balanceOf）
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

  // ── 設定 viem clients ──────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  console.log("=".repeat(60));
  console.log("  Tempo WeatherMarket Arc Testnet e2e 測試");
  console.log("=".repeat(60));
  console.log(`  錢包   : ${account.address}`);
  console.log(`  合約   : ${weatherMarketAddr}`);
  console.log(`  Oracle : ${adminOracleAddr}`);
  console.log(`  USDC   : ${usdcAddr}`);

  // ── 查詢餘額 ────────────────────────────────────────────────────────────────
  const ethBal = await publicClient.getBalance({ address: account.address });
  const usdcBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  console.log(`\n  ETH 餘額  : ${(Number(ethBal) / 1e18).toFixed(4)} ETH`);
  console.log(`  USDC 餘額 : ${(Number(usdcBal) / 1e6).toFixed(2)} USDC`);

  if (usdcBal < e6(10)) {
    throw new Error(`USDC 不足，需要至少 10 USDC，目前 ${Number(usdcBal) / 1e6} USDC`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 1：建立市場
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 1：建立市場");
  console.log("─".repeat(60));

  const now = Math.floor(Date.now() / 1000);
  const LOCK_DELAY = 90;   // 90 秒後可鎖倉
  const TARGET_DELAY = 180; // 180 秒後是目標日期

  const lockTime = now + LOCK_DELAY;
  const targetDate = now + TARGET_DELAY;

  // 5 個區間：≤25 | 26-28 | 29-31 | 32-34 | ≥35
  const buckets: bigint[] = [25n, 28n, 31n, 34n];
  const city = "Taipei";

  console.log(`  city      : ${city}`);
  console.log(`  buckets   : [${buckets.join(", ")}] → 5 個區間`);
  console.log(`  lockTime  : ${new Date(lockTime * 1000).toISOString()} (${LOCK_DELAY}s 後)`);
  console.log(`  targetDate: ${new Date(targetDate * 1000).toISOString()} (${TARGET_DELAY}s 後)`);

  const createHash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "createMarket",
    args: [city, BigInt(targetDate), buckets, BigInt(lockTime)],
    ...GAS_OPTS,
  });
  console.log(`\n  tx hash: ${createHash}`);
  console.log("  等待確認...");

  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

  // 從 log 解析 marketId
  let marketId: bigint | null = null;
  for (const log of createReceipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: wmArtifact.abi,
        data: log.data,
        topics: log.topics,
        eventName: "MarketCreated",
      });
      marketId = (decoded.args as { marketId: bigint }).marketId;
      break;
    } catch {
      // 跳過非相關 log
    }
  }
  if (marketId === null) {
    throw new Error("無法從 tx log 解析 marketId");
  }

  console.log(`\n  ✓ 市場建立成功！marketId = ${marketId}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 2：Approve USDC + 下注
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 2：Approve USDC + 下注");
  console.log("─".repeat(60));

  // Approve 最大金額（只需做一次）
  console.log("  Approve USDC...");
  const approveHash = await walletClient.writeContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "approve",
    args: [weatherMarketAddr, maxUint256],
    ...GAS_OPTS,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  ✓ Approve 完成 (tx: ${approveHash})`);

  // 下注在 bucket 2（29-31°C），預期溫度 30°C → 應得獎
  const betBucket = 2; // bucket index（0-based）
  const betAmount = e6(5); // 5 USDC

  console.log(`\n  下注 5 USDC 在 bucket ${betBucket} (29-31°C)...`);
  const betHash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "placeBet",
    args: [marketId, betBucket, betAmount],
    ...GAS_OPTS,
  });
  await publicClient.waitForTransactionReceipt({ hash: betHash });
  console.log(`  ✓ 下注成功 (tx: ${betHash})`);

  // 查詢市場目前狀態
  const marketAfterBet = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  console.log(`  totalPool : ${Number(marketAfterBet[4]) / 1e6} USDC`);
  console.log(`  status    : ${STATUS_LABEL[marketAfterBet[3]] ?? marketAfterBet[3]}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 3：等待 lockTime → lockMarket
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 3：等待鎖倉時間 → lockMarket");
  console.log("─".repeat(60));

  await waitUntil(lockTime + 2, "lockTime");

  console.log("  呼叫 lockMarket...");
  const lockHash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "lockMarket",
    args: [marketId],
    gas: 150_000n,
    maxPriorityFeePerGas: parseGwei("10"),
    maxFeePerGas: parseGwei("100"),
  });
  await publicClient.waitForTransactionReceipt({ hash: lockHash });
  console.log(`  ✓ 市場已鎖盤 (tx: ${lockHash})`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 4：AdminOracle.submitResult → 結算
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 4：AdminOracle.submitResult → 結算");
  console.log("─".repeat(60));

  const finalTemp = 30n; // 30°C → bucket 2（29-31），下注方得獎

  console.log(`  提交溫度 ${finalTemp}°C → 預期 bucket 2 得獎`);
  const settleHash = await walletClient.writeContract({
    address: adminOracleAddr,
    abi: aoArtifact.abi,
    functionName: "submitResult",
    args: [city, finalTemp, marketId],
    gas: 300_000n,
    maxPriorityFeePerGas: parseGwei("10"),
    maxFeePerGas: parseGwei("100"),
  });
  await publicClient.waitForTransactionReceipt({ hash: settleHash });
  console.log(`  ✓ 結算完成 (tx: ${settleHash})`);

  // 讀取結算後市場狀態
  const marketSettled = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [, , , statusAfter, totalPool, finalTempOnChain, winningBucket] = marketSettled;
  console.log(`  status        : ${STATUS_LABEL[statusAfter] ?? statusAfter}`);
  console.log(`  finalTemp     : ${finalTempOnChain}°C`);
  console.log(`  winningBucket : ${winningBucket}`);
  console.log(`  totalPool     : ${Number(totalPool) / 1e6} USDC`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 5：claimWinnings
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 5：claimWinnings（領獎）");
  console.log("─".repeat(60));

  if (statusAfter !== 2 /* SETTLED */) {
    console.warn("  ⚠️  市場未 SETTLED，跳過領獎");
  } else {
    const usdcBefore = (await publicClient.readContract({
      address: usdcAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    const claimHash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: wmArtifact.abi,
      functionName: "claimWinnings",
      args: [marketId],
      gas: 200_000n,
      maxPriorityFeePerGas: parseGwei("10"),
      maxFeePerGas: parseGwei("100"),
    });
    await publicClient.waitForTransactionReceipt({ hash: claimHash });

    const usdcAfter = (await publicClient.readContract({
      address: usdcAddr,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;

    const earned = usdcAfter - usdcBefore;
    console.log(`  ✓ 領獎成功 (tx: ${claimHash})`);
    console.log(`  領到金額 : ${Number(earned) / 1e6} USDC`);
    console.log(`  USDC 餘額: ${Number(usdcAfter) / 1e6} USDC`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 完成
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  ✅  e2e 測試全部完成！");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n❌ 錯誤:", err.shortMessage ?? err.message);
  if (err.details) console.error("詳情:", err.details);
  process.exit(1);
});
