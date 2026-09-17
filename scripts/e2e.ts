/**
 * Full end-to-end test script for Arc Testnet
 *
 * Flow: create market -> bet -> wait for lock -> lockMarket -> AdminOracle.submitResult -> claimWinnings
 *
 * Usage:
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

// ─── Chain configuration ────────────────────────────────────────────────────────────────────
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

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"] as const;
const USDC_DECIMALS = 6n;
const e6 = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

// ─── Wait helpers ──────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(targetTs: number, label: string) {
  const now = Math.floor(Date.now() / 1000);
  const remaining = targetTs - now;
  if (remaining <= 0) return;
  console.log(`  ⏳ waiting ${remaining}s (${label})...`);
  for (let i = remaining; i > 0; i -= 5) {
    process.stdout.write(`\r  ${i}s remaining  `);
    await sleep(Math.min(5000, i * 1000));
  }
  console.log("\r  ✓ time reached  ");
}

// ─── Main flow ────────────────────────────────────────────────────────────────────
async function main() {
  // ── Load contract addresses and ABI ──────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const adminOracleAddr = deployments.contracts.AdminOracle as Hex;
  const usdcAddr = deployments.contracts.USDC as Hex;

  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const aoArtifact = await hre.artifacts.readArtifact("AdminOracle");

  // Minimal ERC-20 ABI (approve + balanceOf)
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

  // ── Set up viem clients ──────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  console.log("=".repeat(60));
  console.log("  Tempo WeatherMarket Arc Testnet e2e test");
  console.log("=".repeat(60));
  console.log(`  wallet   : ${account.address}`);
  console.log(`  contract : ${weatherMarketAddr}`);
  console.log(`  Oracle : ${adminOracleAddr}`);
  console.log(`  USDC   : ${usdcAddr}`);

  // ── Query balances ────────────────────────────────────────────────────────────────
  const ethBal = await publicClient.getBalance({ address: account.address });
  const usdcBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  console.log(`\n  ETH balance : ${(Number(ethBal) / 1e18).toFixed(4)} ETH`);
  console.log(`  USDC balance : ${(Number(usdcBal) / 1e6).toFixed(2)} USDC`);

  if (usdcBal < e6(10)) {
    throw new Error(`Insufficient USDC: need at least 10 USDC, have ${Number(usdcBal) / 1e6} USDC`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 1: create the market
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 1: create market");
  console.log("─".repeat(60));

  const now = Math.floor(Date.now() / 1000);
  const LOCK_DELAY = 90;   // lockable after 90 seconds
  const TARGET_DELAY = 180; // targetDate is 180 seconds out

  const lockTime = now + LOCK_DELAY;
  const targetDate = now + TARGET_DELAY;

  // 5  ranges: <=25 | 26-28 | 29-31 | 32-34 | >=35
  const buckets: bigint[] = [25n, 28n, 31n, 34n];
  const city = "Taipei";

  console.log(`  city      : ${city}`);
  console.log(`  buckets   : [${buckets.join(", ")}] -> 5 ranges`);
  console.log(`  lockTime  : ${new Date(lockTime * 1000).toISOString()} (in ${LOCK_DELAY}s)`);
  console.log(`  targetDate: ${new Date(targetDate * 1000).toISOString()} (in ${TARGET_DELAY}s)`);

  const createHash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "createMarket",
    args: [city, BigInt(targetDate), buckets, BigInt(lockTime)],
    ...GAS_OPTS,
  });
  console.log(`\n  tx hash: ${createHash}`);
  console.log("  waiting for confirmation...");

  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

  // Parse the marketId from the logs
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
      // Skip unrelated logs
    }
  }
  if (marketId === null) {
    throw new Error("could not parse marketId from the tx logs");
  }

  console.log(`\n  ✓ market created, marketId = ${marketId}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 2: approve USDC + place bets
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 2: approve USDC + place bets");
  console.log("─".repeat(60));

  // Approve the maximum amount (only needed once)
  console.log("  Approve USDC...");
  const approveHash = await walletClient.writeContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "approve",
    args: [weatherMarketAddr, maxUint256],
    ...GAS_OPTS,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  ✓ approve done (tx: ${approveHash})`);

  // Bet on bucket 2 (29-31°C); the expected temperature of 30°C should win
  const betBucket = 2; // bucket index（0-based）
  const betAmount = e6(5); // 5 USDC

  console.log(`\n  betting 5 USDC on bucket ${betBucket} (29-31°C)...`);
  const betHash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "placeBet",
    args: [marketId, betBucket, betAmount],
    ...GAS_OPTS,
  });
  await publicClient.waitForTransactionReceipt({ hash: betHash });
  console.log(`  ✓ bet placed (tx: ${betHash})`);

  // Query the market's current status
  const marketAfterBet = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: wmArtifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  console.log(`  totalPool : ${Number(marketAfterBet[4]) / 1e6} USDC`);
  console.log(`  status    : ${STATUS_LABEL[marketAfterBet[3]] ?? marketAfterBet[3]}`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 3: wait for lockTime -> lockMarket
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 3: wait for lock time -> lockMarket");
  console.log("─".repeat(60));

  await waitUntil(lockTime + 2, "lockTime");

  console.log("  calling lockMarket...");
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
  console.log(`  ✓ market locked (tx: ${lockHash})`);

  // ─────────────────────────────────────────────────────────────────────────────
  // STEP 4: AdminOracle.submitResult -> settle
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("STEP 4: AdminOracle.submitResult -> settle");
  console.log("─".repeat(60));

  const finalTemp = 30n; // 30°C -> bucket 2 (29-31), the bettor wins

  console.log(`  submitting ${finalTemp}°C -> bucket 2 expected to win`);
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
  console.log(`  ✓ settled (tx: ${settleHash})`);

  // Read the market status after settlement
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
  console.log("STEP 5: claimWinnings");
  console.log("─".repeat(60));

  if (statusAfter !== 2 /* SETTLED */) {
    console.warn("  ⚠️  market is not SETTLED, skipping the claim");
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
    console.log(`  ✓ winnings claimed (tx: ${claimHash})`);
    console.log(`  amount received : ${Number(earned) / 1e6} USDC`);
    console.log(`  USDC balance: ${Number(usdcAfter) / 1e6} USDC`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Done
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("  ✅  e2e test complete");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n❌ Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
