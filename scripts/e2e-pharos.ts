import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const pharosAtlantic = defineChain({
  id: 688689,
  name: "Pharos Atlantic Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://atlantic.dplabs-internal.com"] },
  },
});

// gas=1M × gasPrice=10gwei = 0.01 ETH 保證金（帳戶 ETH 充足）
const GAS_OPTS = {
  gas: 1_000_000n,
  gasPrice: parseGwei("10"),
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitUntil(targetTimestamp: number, label: string): Promise<void> {
  const remaining = targetTimestamp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) {
    console.log(`  ${label} 已到達，繼續執行`);
    return;
  }
  console.log(`  等待 ${label}（還有 ${remaining} 秒）...`);
  await sleep(remaining * 1000 + 3000); // 多等 3 秒讓鏈上時間同步
  console.log(`  ${label} 已到達`);
}

// 等待收據並檢查是否 reverted
async function checkTx(
  publicClient: ReturnType<typeof createPublicClient>,
  label: string,
  hash: Hex,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`❌ ${label} reverted! tx: ${hash}`);
  }
  console.log(`  ✓ ${label}: ${hash}`);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");

  // 讀取部署地址
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentPath = resolve(__dirname, "../deployments/pharos-testnet-mock.json");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));

  const mockUsdcAddress = deployment.contracts.MockUSDC as Hex;
  const weatherMarketAddress = deployment.contracts.WeatherMarket as Hex;
  const adminOracleAddress = deployment.contracts.AdminOracle as Hex;

  console.log("=== Pharos Atlantic E2E 測試 ===");
  console.log("MockUSDC:     ", mockUsdcAddress);
  console.log("WeatherMarket:", weatherMarketAddress);
  console.log("AdminOracle:  ", adminOracleAddress);

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);
  console.log("Deployer:     ", account.address);

  const walletClient = createWalletClient({
    account,
    chain: pharosAtlantic,
    transport: http(),
  });
  const publicClient = createPublicClient({
    chain: pharosAtlantic,
    transport: http(),
  });

  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const oracleArtifact = await hre.artifacts.readArtifact("AdminOracle");
  const usdcArtifact = await hre.artifacts.readArtifact("MockUSDC");

  // --- 讀取初始餘額 ---
  const balanceBefore = await publicClient.readContract({
    address: mockUsdcAddress,
    abi: usdcArtifact.abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;
  console.log(`\n初始 USDC 餘額: ${Number(balanceBefore) / 1e6} USDC`);

  // --- 若餘額不足，先 mint 1000 USDC ---
  if (balanceBefore < 100_000_000n) {
    console.log("餘額不足，先 mint 1000 USDC...");
    await checkTx(
      publicClient,
      "mint 1000 USDC",
      await walletClient.writeContract({
        address: mockUsdcAddress,
        abi: usdcArtifact.abi,
        functionName: "mint",
        args: [account.address, 1_000_000_000n],
        ...GAS_OPTS,
      }),
    );
    const newBalance = await publicClient.readContract({
      address: mockUsdcAddress,
      abi: usdcArtifact.abi,
      functionName: "balanceOf",
      args: [account.address],
    }) as bigint;
    console.log(`  mint 後餘額: ${Number(newBalance) / 1e6} USDC`);
  }

  // --- Step 1: createMarket ---
  // buckets = [20, 25, 30, 35]
  // → bucket 0 (≤20), 1 (20~25], 2 (25~30], 3 (30~35], 4 (>35)
  // 溫度 28°C → bucket 2
  const nowSec = Math.floor(Date.now() / 1000);
  const lockTime = BigInt(nowSec + 5 * 60);
  const targetDate = BigInt(nowSec + 10 * 60);
  const buckets = [20n, 25n, 30n, 35n]; // int256[]

  console.log("\n[1/7] createMarket（Taipei, buckets=[20,25,30,35]）...");
  console.log(`  lockTime:   ${new Date(Number(lockTime) * 1000).toLocaleTimeString()}`);
  console.log(`  targetDate: ${new Date(Number(targetDate) * 1000).toLocaleTimeString()}`);

  await checkTx(
    publicClient,
    "createMarket",
    await walletClient.writeContract({
      address: weatherMarketAddress,
      abi: wmArtifact.abi,
      functionName: "createMarket",
      args: ["Taipei", targetDate, buckets, lockTime],
      ...GAS_OPTS,
    }),
  );

  // nextMarketId 在 createMarket 後應為 1，第一個市場 = 0
  const nextMarketId = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "nextMarketId",
  }) as bigint;
  console.log(`  nextMarketId after create: ${nextMarketId}`);
  if (nextMarketId === 0n) throw new Error("createMarket 沒有成功：nextMarketId 仍為 0");
  const marketId = nextMarketId - 1n; // 剛建的市場 ID
  console.log(`  marketId: ${marketId}`);

  // --- Step 2: approve 100 USDC ---
  console.log("\n[2/7] approve 100 USDC 給 WeatherMarket...");
  await checkTx(
    publicClient,
    "approve",
    await walletClient.writeContract({
      address: mockUsdcAddress,
      abi: usdcArtifact.abi,
      functionName: "approve",
      args: [weatherMarketAddress, 100_000_000n],
      ...GAS_OPTS,
    }),
  );

  // --- Step 3: placeBet（bucket 2, 100 USDC）---
  console.log("\n[3/7] placeBet（bucket 2 = 25~30°C, 100 USDC）...");
  await checkTx(
    publicClient,
    "placeBet",
    await walletClient.writeContract({
      address: weatherMarketAddress,
      abi: wmArtifact.abi,
      functionName: "placeBet",
      args: [marketId, 2, 100_000_000n],
      ...GAS_OPTS,
    }),
  );

  // 確認 bucket total
  const bucketTotal = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "bucketTotals",
    args: [marketId, 2],
  }) as bigint;
  console.log(`  bucket[2] total: ${Number(bucketTotal) / 1e6} USDC`);

  // --- Step 4: 等待 lockTime ---
  console.log("\n[4/7] 等待 lockTime...");
  await waitUntil(Number(lockTime), "lockTime");

  // --- Step 5: lockMarket ---
  console.log("\n[5/7] lockMarket...");
  await checkTx(
    publicClient,
    "lockMarket",
    await walletClient.writeContract({
      address: weatherMarketAddress,
      abi: wmArtifact.abi,
      functionName: "lockMarket",
      args: [marketId],
      ...GAS_OPTS,
    }),
  );

  // --- Step 6: AdminOracle submitResult（28°C → bucket 2）---
  console.log("\n[6/7] AdminOracle.submitResult（Taipei, 28°C, marketId）...");
  await checkTx(
    publicClient,
    "submitResult",
    await walletClient.writeContract({
      address: adminOracleAddress,
      abi: oracleArtifact.abi,
      functionName: "submitResult",
      args: ["Taipei", 28n, marketId],
      ...GAS_OPTS,
    }),
  );

  // --- 確認市場狀態 ---
  const rawMarket = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "getMarket",
    args: [marketId],
  });

  // viem 可能回傳 array 或 object，兩者都支援
  let city: string, status: number, totalPool: bigint, finalTemp: bigint,
      winningBucket: number, noWinner: boolean;

  if (Array.isArray(rawMarket)) {
    [city, , , status, totalPool, finalTemp, winningBucket, , noWinner] =
      rawMarket as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];
  } else {
    const m = rawMarket as Record<string, unknown>;
    city = m.city as string;
    status = Number(m.status);
    totalPool = m.totalPool as bigint;
    finalTemp = m.finalTemp as bigint;
    winningBucket = Number(m.winningBucket);
    noWinner = m.noWinner as boolean;
  }

  const statusLabel = ["OPEN", "LOCKED", "SETTLED"][status] ?? `未知(${status})`;
  console.log("\n--- 市場結果 ---");
  console.log(`  城市:         ${city}`);
  console.log(`  狀態:         ${statusLabel}`);
  console.log(`  totalPool:    ${Number(totalPool) / 1e6} USDC`);
  console.log(`  finalTemp:    ${finalTemp}°C`);
  console.log(`  winningBucket: ${winningBucket}（期望: 2）`);
  console.log(`  noWinner:     ${noWinner}`);

  if (status !== 2) throw new Error(`市場狀態不是 SETTLED（是 ${statusLabel}），無法 claim`);
  if (winningBucket !== 2) throw new Error(`winningBucket 應為 2，實際為 ${winningBucket}`);

  // --- Step 7: claimWinnings ---
  console.log("\n[7/7] claimWinnings...");
  await checkTx(
    publicClient,
    "claimWinnings",
    await walletClient.writeContract({
      address: weatherMarketAddress,
      abi: wmArtifact.abi,
      functionName: "claimWinnings",
      args: [marketId],
      ...GAS_OPTS,
    }),
  );

  // --- 最終 USDC 餘額 ---
  const balanceAfter = await publicClient.readContract({
    address: mockUsdcAddress,
    abi: usdcArtifact.abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;

  const effectiveBefore =
    balanceBefore < 100_000_000n ? balanceBefore + 1_000_000_000n : balanceBefore;

  console.log("\n=== 測試結果 ===");
  console.log(`  下注前餘額:  ${Number(effectiveBefore) / 1e6} USDC`);
  console.log(`  最終餘額:    ${Number(balanceAfter) / 1e6} USDC`);
  const diff = Number(balanceAfter) - Number(effectiveBefore);
  console.log(`  差額:        ${diff >= 0 ? "+" : ""}${diff / 1e6} USDC（2% 手續費已扣除）`);
  console.log("  期望差額:    -2 USDC（100 USDC 押注 × 2% 手續費）");
  console.log("\n✓ E2E 測試通過");
}

main().catch((err) => {
  console.error("\nE2E failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
