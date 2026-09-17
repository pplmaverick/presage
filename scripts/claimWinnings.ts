import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  decodeEventLog,
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
  // Usage: MARKET_ID=0 npx hardhat run scripts/claimWinnings.ts --network arc
  if (!process.env.MARKET_ID) throw new Error("set the MARKET_ID environment variable");
  const marketId = BigInt(process.env.MARKET_ID);

  // ── Load deployed addresses ────────────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  // ── Set up viem clients ───────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  // ── Read market info ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, , status, totalPool, , winningBucket] = marketData;

  console.log("Market info");
  console.log("  marketId     :", marketId.toString());
  console.log("  city         :", city);
  console.log("  status       :", STATUS_LABEL[status] ?? status);
  console.log("  targetDate   :", new Date(Number(targetDate) * 1000).toISOString());
  console.log("  totalPool    :", (totalPool / 10n ** 6n).toString(), "USDC");
  if (status === 2) console.log("  winningBucket:", winningBucket);

  if (status !== 2 /* SETTLED */) {
    console.error(`\nError: market status is ${STATUS_LABEL[status] ?? status}; only SETTLED markets can be claimed.`);
    process.exit(1);
  }

  // ── Check whether it was already claimed ────────────────────────────────────────────────────────
  const alreadyClaimed = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "claimed",
    args: [marketId, account.address],
  })) as boolean;

  if (alreadyClaimed) {
    console.error("\nError: this address has already claimed this market.");
    process.exit(1);
  }

  // ── Send the transaction ─────────────────────────────────────────────────────────────────
  console.log("\nsending claimWinnings...");
  const hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "claimWinnings",
    args: [marketId],
    gas: 150_000n,
    maxPriorityFeePerGas: parseGwei("10"),
    maxFeePerGas: parseGwei("100"),
  });

  console.log("tx hash:", hash);
  console.log("waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── Parse the WinningsClaimed event for the payout ─────────────────────────────────────
  let payout = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== weatherMarketAddr.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "WinningsClaimed") {
        payout = (decoded.args as { amount: bigint }).amount;
      }
    } catch {
      // Not the event we want, skip
    }
  }

  if (payout > 0n) {
    console.log(`\n✓ claim succeeded, received ${(payout / 10n ** 6n).toString()} USDC`);
  } else {
    console.log("\n✓ transaction confirmed (amount not parseable from logs — check the tx hash)");
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
