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
  const targetDate = now + 3 * 24 * 3_600; // today + 3 days
  const lockTime = now + 2 * 24 * 3_600;   // today + 2 days

  // 5  ranges: <=28 | 29-31 | 32-34 | 35-37 | >37°C
  const buckets = [28n, 31n, 34n, 37n];
  const city = "Bangkok";

  console.log("Creating market on WeatherMarket:", weatherMarketAddr);
  console.log("  city      :", city);
  console.log("  targetDate:", new Date(targetDate * 1000).toISOString());
  console.log("  lockTime  :", new Date(lockTime * 1000).toISOString());
  console.log("  buckets   :", `[${buckets.join(",")}] -> ${buckets.length + 1} ranges`);

  const hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "createMarket",
    args: [city, BigInt(targetDate), buckets, BigInt(lockTime)],
    ...GAS_OPTS,
  });

  console.log("\ntx hash:", hash);
  console.log("waiting for confirmation...");

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
