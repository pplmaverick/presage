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
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const GAS_OPTS = {
  gas: 500_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

// 2026-07-10 08:00:00 UTC
const TARGET_DATE = 1783670400n;
// 2026-07-10 07:00:00 UTC（targetDate 前 1 小時）
const LOCK_TIME = 1783666800n;

const MARKETS = [
  { city: "Taipei",  buckets: [25n, 28n, 31n, 34n] },
  { city: "Tokyo",   buckets: [22n, 25n, 28n, 31n] },
  { city: "Bangkok", buckets: [30n, 32n, 34n, 36n] },
  { city: "Seoul",   buckets: [20n, 23n, 26n, 29n] },
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

  for (const { city, buckets } of MARKETS) {
    console.log(`\n>>> 建立 ${city} 市場`);
    console.log(`    buckets: [${buckets.join(",")}] → ${buckets.length + 1} 個區間`);

    const hash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "createMarket",
      args: [city, TARGET_DATE, buckets, LOCK_TIME],
      ...GAS_OPTS,
    });

    console.log(`    tx hash : ${hash}`);
    console.log(`    等待確認...`);

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
        // 跳過不相關的 log
      }
    }

    if (marketId === null) {
      console.error(`    ❌ 無法從 logs 解析 marketId`);
      continue;
    }

    console.log(`    ✓ marketId: ${marketId}`);
    results.push({ city, marketId: marketId.toString(), txHash: hash });
  }

  console.log("\n" + "═".repeat(60));
  console.log("四筆市場建立結果：");
  console.log("─".repeat(60));
  for (const r of results) {
    console.log(`  ${r.city.padEnd(8)} marketId=${r.marketId}  tx=${r.txHash}`);
  }
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
