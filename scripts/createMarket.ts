import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  decodeEventLog,
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

async function main() {
  // ── Load deployed addresses ────────────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(
      resolve(__dirname, "../deployments/arc-testnet.json"),
      "utf-8",
    ),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  // ── Set up viem clients ───────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(undefined, {
      fetchOptions: { headers: { Origin: "http://localhost" } },
    }),
  });
  const publicClient = createPublicClient({
    chain: arc,
    transport: http(undefined, {
      fetchOptions: { headers: { Origin: "http://localhost" } },
    }),
  });

  // ── Time parameters (fixed: 2026-08-10 09:00 / 08:00 UTC)──────────────────────────────
  const targetDate = 1786352400n; // 2026-08-10T09:00:00Z
  const lockTime = 1786348800n;   // 2026-08-10T08:00:00Z

  // 5  ranges: <=25 | 25-28 | 28-31 | 31-34 | >34
  const buckets = [25n, 28n, 31n, 34n];

  console.log("Creating market on WeatherMarket:", weatherMarketAddr);
  console.log("  city      :", "Tokyo");
  console.log("  targetDate:", new Date(Number(targetDate) * 1000).toISOString());
  console.log("  lockTime  :", new Date(Number(lockTime) * 1000).toISOString());
  console.log("  buckets   :", `[${buckets.join(",")}] -> ${buckets.length + 1} ranges`);

  // ── Send the transaction ─────────────────────────────────────────────────────────────────
  const hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "createMarket",
    args: ["Tokyo", BigInt(targetDate), buckets, BigInt(lockTime)],
    ...GAS_OPTS,
  });

  console.log("\ntx hash:", hash);
  console.log("waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── Parse the MarketCreated event for the marketId ──────────────────────────────────────
  let marketId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: artifact.abi,
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

  if (marketId !== null) {
    console.log("\n✓ market created");
    console.log("  marketId  :", marketId.toString());
    console.log("  tx hash   :", hash);
  } else {
    console.warn("\nWarning: could not parse marketId from the logs; check the tx receipt");
    console.log("  tx hash   :", hash);
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
