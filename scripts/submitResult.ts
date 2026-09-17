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

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] } },
});

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"];

async function main() {
  // Usage: MARKET_ID=0 TEMP=29 npx hardhat run scripts/submitResult.ts --network arc
  if (!process.env.MARKET_ID) throw new Error("set the MARKET_ID environment variable");
  if (!process.env.TEMP) throw new Error("set the TEMP environment variable (whole degrees Celsius)");
  const marketId = BigInt(process.env.MARKET_ID);
  const temp = BigInt(process.env.TEMP);

  // ── Load deployed addresses ────────────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(
      resolve(__dirname, "../deployments/arc-testnet.json"),
      "utf-8",
    ),
  );
  const adminOracleAddr = deployments.contracts.AdminOracle as Hex;
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;

  const aoArt = await hre.artifacts.readArtifact("AdminOracle");
  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");

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

  // ── Read market info ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: wmArt.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, lockTime, status, totalPool, , , buckets] = marketData;

  console.log("Market info");
  console.log("  marketId  :", marketId.toString());
  console.log("  city      :", city);
  console.log("  status    :", STATUS_LABEL[status] ?? status);
  console.log(
    "  targetDate:",
    new Date(Number(targetDate) * 1000).toISOString(),
  );
  console.log(
    "  lockTime  :",
    new Date(Number(lockTime) * 1000).toISOString(),
  );
  console.log("  totalPool :", (totalPool / 10n ** 6n).toString(), "USDC");
  console.log("  buckets   :", `[${buckets.join(",")}]`);

  if (status !== 1 /* LOCKED */) {
    console.warn(
      `\nWarning: market status is ${STATUS_LABEL[status] ?? status}, not LOCKED.`,
    );
    console.warn("  submitResult only succeeds while the market is LOCKED.");
  }

  // ── Compute the winning bucket (preview only; the chain recomputes it)────────────────────────────────────────
  let bucketPreview = buckets.length; // default: above the highest upper bound
  for (let i = 0; i < buckets.length; i++) {
    if (temp <= buckets[i]) {
      bucketPreview = i;
      break;
    }
  }
  console.log(
    `\nSubmitting ${temp}°C -> expected winning bucket ${bucketPreview}`,
  );

  // ── Send the transaction ─────────────────────────────────────────────────────────────────
  const hash = await walletClient.writeContract({
    address: adminOracleAddr,
    abi: aoArt.abi,
    functionName: "submitResult",
    args: [city, temp, marketId],
    gas: 300_000n,
    maxPriorityFeePerGas: parseGwei("10"),
    maxFeePerGas: parseGwei("100"),
  });

  console.log("\ntx hash:", hash);
  console.log("waiting for confirmation...");

  await publicClient.waitForTransactionReceipt({ hash });
  console.log("✓ result submitted");
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
