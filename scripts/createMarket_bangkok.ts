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
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(
      resolve(__dirname, "../deployments/arc-testnet.json"),
      "utf-8",
    ),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  const now = Math.floor(Date.now() / 1000);
  const targetDate = now + 3 * 24 * 3_600; // 今天 + 3 天
  const lockTime = now + 2 * 24 * 3_600;   // 今天 + 2 天

  // 5 個區間：≤28 | 29-31 | 32-34 | 35-37 | >37°C
  const buckets = [28n, 31n, 34n, 37n];
  const city = "Bangkok";

  console.log("Creating market on WeatherMarket:", weatherMarketAddr);
  console.log("  city      :", city);
  console.log("  targetDate:", new Date(targetDate * 1000).toISOString());
  console.log("  lockTime  :", new Date(lockTime * 1000).toISOString());
  console.log("  buckets   :", `[${buckets.join(",")}] → ${buckets.length + 1} 個區間`);

  const hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "createMarket",
    args: [city, BigInt(targetDate), buckets, BigInt(lockTime)],
    ...GAS_OPTS,
  });

  console.log("\ntx hash:", hash);
  console.log("等待確認...");

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
    console.log("\n✓ 市場建立成功");
    console.log("  marketId  :", marketId.toString());
    console.log("  tx hash   :", hash);
  } else {
    console.warn("\n警告：無法從 logs 解析 marketId，請從 tx receipt 查詢");
    console.log("  tx hash   :", hash);
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
