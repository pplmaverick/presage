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

// gas=1M × gasPrice=10gwei = 0.01 ETH  deposit (the account has plenty of ETH)
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
    console.log(`  ${label} reached, continuing`);
    return;
  }
  console.log(`  waiting for ${label} (${remaining}s to go)...`);
  await sleep(remaining * 1000 + 3000); // 3s extra so on-chain time catches up
  console.log(`  ${label} reached`);
}

// Await the receipt and check whether it reverted
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

  // Load deployed addresses
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentPath = resolve(__dirname, "../deployments/pharos-testnet-mock.json");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));

  const mockUsdcAddress = deployment.contracts.MockUSDC as Hex;
  const weatherMarketAddress = deployment.contracts.WeatherMarket as Hex;
  const adminOracleAddress = deployment.contracts.AdminOracle as Hex;

  console.log("=== Pharos Atlantic E2E test ===");
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

  // --- Read the starting balance ---
  const balanceBefore = await publicClient.readContract({
    address: mockUsdcAddress,
    abi: usdcArtifact.abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;
  console.log(`\nstarting USDC balance: ${Number(balanceBefore) / 1e6} USDC`);

  // --- If the balance is short, mint 1000 USDC first ---
  if (balanceBefore < 100_000_000n) {
    console.log("Balance too low, minting 1000 USDC first...");
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
    console.log(`  balance after mint: ${Number(newBalance) / 1e6} USDC`);
  }

  // --- Step 1: createMarket ---
  // buckets = [20, 25, 30, 35]
  // → bucket 0 (≤20), 1 (20~25], 2 (25~30], 3 (30~35], 4 (>35)
  // temperature 28°C -> bucket 2
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

  // nextMarketId should be 1 after createMarket, so the first market is 0
  const nextMarketId = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "nextMarketId",
  }) as bigint;
  console.log(`  nextMarketId after create: ${nextMarketId}`);
  if (nextMarketId === 0n) throw new Error("createMarket did not succeed: nextMarketId is still 0");
  const marketId = nextMarketId - 1n; // the market just created
  console.log(`  marketId: ${marketId}`);

  // --- Step 2: approve 100 USDC ---
  console.log("\n[2/7] approving 100 USDC for WeatherMarket...");
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

  // Check the bucket total
  const bucketTotal = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "bucketTotals",
    args: [marketId, 2],
  }) as bigint;
  console.log(`  bucket[2] total: ${Number(bucketTotal) / 1e6} USDC`);

  // --- Step 4: wait for lockTime ---
  console.log("\n[4/7] waiting for lockTime...");
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

  // --- Check market status ---
  const rawMarket = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "getMarket",
    args: [marketId],
  });

  // viem may return an array or an object; both are handled
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

  const statusLabel = ["OPEN", "LOCKED", "SETTLED"][status] ?? `unknown(${status})`;
  console.log("\n--- market result ---");
  console.log(`  city:   ${city}`);
  console.log(`  status: ${statusLabel}`);
  console.log(`  totalPool:    ${Number(totalPool) / 1e6} USDC`);
  console.log(`  finalTemp:    ${finalTemp}°C`);
  console.log(`  winningBucket: ${winningBucket} (expected: 2)`);
  console.log(`  noWinner:     ${noWinner}`);

  if (status !== 2) throw new Error(`market status is ${statusLabel}, not SETTLED — cannot claim`);
  if (winningBucket !== 2) throw new Error(`winningBucket should be 2, got ${winningBucket}`);

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

  // --- Final USDC balance ---
  const balanceAfter = await publicClient.readContract({
    address: mockUsdcAddress,
    abi: usdcArtifact.abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;

  const effectiveBefore =
    balanceBefore < 100_000_000n ? balanceBefore + 1_000_000_000n : balanceBefore;

  console.log("\n=== test result ===");
  console.log(`  balance before bet: ${Number(effectiveBefore) / 1e6} USDC`);
  console.log(`  final balance: ${Number(balanceAfter) / 1e6} USDC`);
  const diff = Number(balanceAfter) - Number(effectiveBefore);
  console.log(`  delta:  ${diff >= 0 ? "+" : ""}${diff / 1e6} USDC (2% fee already deducted)`);
  console.log("  expected delta: -2 USDC (100 USDC staked x 2% fee)");
  console.log("\n✓ E2E test passed");
}

main().catch((err) => {
  console.error("\nE2E failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
