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
  const raw = process.env.MARKET_ID;
  if (!raw) throw new Error("set the MARKET_ID environment variable, e.g. MARKET_ID=0 npx hardhat run ...");
  const marketId = BigInt(raw);

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

  // ── Read market status ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, lockTime, status, totalPool] = marketData;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  console.log("Market info");
  console.log("  marketId  :", marketId.toString());
  console.log("  city      :", city);
  console.log("  status    :", STATUS_LABEL[status] ?? status);
  console.log("  lockTime  :", new Date(Number(lockTime) * 1000).toISOString());
  console.log("  targetDate:", new Date(Number(targetDate) * 1000).toISOString());
  console.log("  totalPool :", (totalPool / 10n ** 6n).toString(), "USDC");

  if (status !== 0 /* OPEN */) {
    console.error(`\nError: market status is ${STATUS_LABEL[status] ?? status}; only OPEN markets can be locked.`);
    process.exit(1);
  }

  if (nowSec < lockTime) {
    const remaining = Number(lockTime - nowSec);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.error(`\nError: lockTime has not been reached; ${mins}m ${secs}s to go.`);
    console.error(`  lockTime: ${new Date(Number(lockTime) * 1000).toISOString()}`);
    process.exit(1);
  }

  // ── Send the transaction ─────────────────────────────────────────────────────────────────
  console.log("\nlocking...");
  const hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "lockMarket",
    args: [marketId],
    gas: 100_000n,
    maxPriorityFeePerGas: parseGwei("10"),
    maxFeePerGas: parseGwei("100"),
  });

  console.log("tx hash:", hash);
  console.log("waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("\n✓ market locked, no further bets accepted");
  console.log("  Next: wait for targetDate, then call submitResult");
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
