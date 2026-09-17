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

// 2026-05-24 00:00:00 UTC
const TARGET_DATE = 1779580800n;
// 2026-05-23 00:00:00 UTC (1 day before targetDate)
const LOCK_TIME = 1779494400n;

const CITIES = [
  { name: "Tokyo",   buckets: [20n, 23n, 26n, 29n] },
  { name: "Bangkok", buckets: [28n, 31n, 34n, 37n] },
  { name: "Seoul",   buckets: [18n, 22n, 26n, 30n] },
];

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  console.log("WeatherMarket:", weatherMarketAddr);
  console.log("targetDate   :", new Date(Number(TARGET_DATE) * 1000).toISOString());
  console.log("lockTime     :", new Date(Number(LOCK_TIME) * 1000).toISOString());
  console.log("─".repeat(60));

  const results: { city: string; marketId: string; txHash: string }[] = [];

  for (const { name, buckets } of CITIES) {
    console.log(`\n>>> creating the ${name} market`);
    console.log(`    buckets: [${buckets.join(",")}] -> ${buckets.length + 1} ranges`);

    const hash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "createMarket",
      args: [name, TARGET_DATE, buckets, LOCK_TIME],
      ...GAS_OPTS,
    });

    console.log(`    tx hash : ${hash}`);
    console.log(`    waiting for confirmation...`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

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

    if (marketId === null) {
      console.error(`    ❌ could not parse marketId from the logs`);
      continue;
    }

    console.log(`    ✓ marketId: ${marketId}`);
    results.push({ city: name, marketId: marketId.toString(), txHash: hash });
  }

  console.log("\n" + "═".repeat(60));
  console.log("All done — update CITY_MARKETS in config.ts:");
  console.log("─".repeat(60));
  for (const r of results) {
    console.log(`  ${r.city.padEnd(8)}: marketId = ${r.marketId}  (tx: ${r.txHash.slice(0, 14)}...)`);
  }
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
