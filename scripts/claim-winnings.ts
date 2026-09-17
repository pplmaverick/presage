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
const MARKET_IDS = [29n, 30n];

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
  console.log(`Signer: ${account.address}`);
  console.log(
    "(Every script in this project currently shares one PRIVATE_KEY: deploy / lockMarket / submitResult / placeBet all use this address,",
  );
  console.log(
    " so claimWinnings only succeeds when this address itself placed a bet and picked the winning bucket; otherwise it reverts.)\n",
  );

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

  const summary: {
    id: bigint;
    result: string;
    hash?: string;
  }[] = [];

  for (const marketId of MARKET_IDS) {
    const marketData = (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "getMarket",
      args: [marketId],
    })) as [
      string,
      bigint,
      bigint,
      number,
      bigint,
      bigint,
      number,
      bigint[],
      boolean,
    ];

    const [city, , , status, totalPool, , winningBucket, , noWinner] =
      marketData;

    console.log(`\nMarket #${marketId} (${city})`);
    console.log(`  status       : ${STATUS_LABEL[status] ?? status}`);
    console.log(`  totalPool    : ${(totalPool / 10n ** 6n).toString()} USDC`);
    console.log(`  noWinner     : ${noWinner}`);
    if (status === 2) console.log(`  winningBucket: ${winningBucket}`);

    if (status !== 2 /* SETTLED */) {
      console.log(`  skipped: status is not SETTLED`);
      summary.push({ id: marketId, result: `skipped (status=${STATUS_LABEL[status] ?? status})` });
      continue;
    }

    const alreadyClaimed = (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "claimed",
      args: [marketId, account.address],
    })) as boolean;

    if (alreadyClaimed) {
      console.log(`  skipped: this address already claimed`);
      summary.push({ id: marketId, result: "skipped (already claimed)" });
      continue;
    }

    // ── Read on-chain state up front to predict whether this signer's call would revert ────────────────────────────
    let predictedPayoutBasis = 0n;
    if (noWinner) {
      predictedPayoutBasis = (await publicClient.readContract({
        address: weatherMarketAddr,
        abi: artifact.abi,
        functionName: "userTotalBets",
        args: [marketId, account.address],
      })) as bigint;
    } else {
      predictedPayoutBasis = (await publicClient.readContract({
        address: weatherMarketAddr,
        abi: artifact.abi,
        functionName: "bets",
        args: [marketId, winningBucket, account.address],
      })) as bigint;
    }

    if (predictedPayoutBasis === 0n) {
      const reason = noWinner
        ? "WeatherMarket: no bets to refund"
        : "WeatherMarket: no winning bet";
      console.log(
        `  skipped: this signer has nothing claimable in this market (expected revert: "${reason}"), no transaction sent`,
      );
      summary.push({ id: marketId, result: `skipped (expected revert: ${reason})` });
      continue;
    }

    try {
      console.log(`  sending claimWinnings...`);
      const hash = await walletClient.writeContract({
        address: weatherMarketAddr,
        abi: artifact.abi,
        functionName: "claimWinnings",
        args: [marketId],
        gas: 150_000n,
        maxPriorityFeePerGas: parseGwei("10"),
        maxFeePerGas: parseGwei("100"),
      });

      console.log(`  tx hash : ${hash}`);
      console.log(`  waiting for confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let payout = 0n;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== weatherMarketAddr.toLowerCase())
          continue;
        try {
          const decoded = decodeEventLog({
            abi: artifact.abi,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          });
          if (decoded.eventName === "WinningsClaimed") {
            payout = (decoded.args as { amount: bigint }).amount;
          }
        } catch {
          // Not the event we want, skip
        }
      }

      console.log(
        `  ✓ success, received ${(payout / 10n ** 6n).toString()} USDC`,
      );
      summary.push({
        id: marketId,
        result: `success, received ${(payout / 10n ** 6n).toString()} USDC`,
        hash,
      });
    } catch (e: any) {
      const reason = e.shortMessage ?? e.message;
      console.log(`  ✗ revert: ${reason}`);
      summary.push({ id: marketId, result: `revert: ${reason}` });
    }
  }

  console.log("\n=== Summary ===");
  for (const s of summary) {
    console.log(
      `Market #${s.id}: ${s.result}${s.hash ? ` tx=${s.hash}` : ""}`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
