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

  const now = Math.floor(Date.now() / 1000);
  const targetDate = now + 7 * 24 * 3_600;   // +7 天
  const lockTime   = targetDate - 3_600;      // targetDate 前 1 小時

  console.log("WeatherMarket:", weatherMarketAddr);
  console.log("targetDate   :", new Date(targetDate * 1000).toISOString());
  console.log("lockTime     :", new Date(lockTime   * 1000).toISOString());
  console.log("");

  const results: { city: string; marketId: string; hash: Hex }[] = [];

  for (const { city, buckets } of MARKETS) {
    console.log(`── Creating market: ${city} ──`);
    console.log(`   buckets: [${buckets.join(",")}] → ${buckets.length + 1} 區間`);

    const hash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "createMarket",
      args: [city, BigInt(targetDate), buckets, BigInt(lockTime)],
      ...GAS_OPTS,
    });

    console.log(`   tx hash : ${hash}`);
    console.log(`   等待確認...`);

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

    if (marketId !== null) {
      console.log(`   ✓ marketId: ${marketId}\n`);
      results.push({ city, marketId: marketId.toString(), hash });
    } else {
      console.warn(`   ⚠ 無法解析 marketId，請查詢 tx receipt\n`);
      results.push({ city, marketId: "unknown", hash });
    }
  }

  console.log("════════════════════════════════");
  console.log("四個市場建立結果：");
  for (const r of results) {
    console.log(`  ${r.city.padEnd(8)} marketId=${r.marketId}  tx=${r.hash}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
