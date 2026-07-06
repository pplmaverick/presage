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
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"];
const MARKET_IDS = [11n, 13n, 14n]; // #12 Tokyo totalPool=0，跳過

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
  console.log(`Signer 地址: ${account.address}`);
  console.log(
    "（本專案所有腳本目前都共用同一把 PRIVATE_KEY：deploy / lockMarket / submitResult / placeBet 都是這個地址，",
  );
  console.log(
    " 所以只有在這個地址自己下注過、且押中該市場的獲勝區間時，claimWinnings 才會成功；否則會 revert。）\n",
  );

  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

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
      console.log(`  跳過：狀態不是 SETTLED`);
      summary.push({ id: marketId, result: `跳過（狀態=${STATUS_LABEL[status] ?? status}）` });
      continue;
    }

    const alreadyClaimed = (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "claimed",
      args: [marketId, account.address],
    })) as boolean;

    if (alreadyClaimed) {
      console.log(`  跳過：此地址已 claim 過`);
      summary.push({ id: marketId, result: "跳過（已 claim 過）" });
      continue;
    }

    // ── 事先讀鏈上狀態，預判這個 signer 呼叫會不會 revert ────────────────────────────
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
        `  跳過：此 signer 地址在這個市場沒有可領取的下注（預期 revert: "${reason}"），不送出交易`,
      );
      summary.push({ id: marketId, result: `跳過（預期 revert: ${reason}）` });
      continue;
    }

    try {
      console.log(`  送出 claimWinnings...`);
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
      console.log(`  等待確認...`);
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
          // 非目標 event，跳過
        }
      }

      console.log(
        `  ✓ success，領回 ${(payout / 10n ** 6n).toString()} USDC`,
      );
      summary.push({
        id: marketId,
        result: `success，領回 ${(payout / 10n ** 6n).toString()} USDC`,
        hash,
      });
    } catch (e: any) {
      const reason = e.shortMessage ?? e.message;
      console.log(`  ✗ revert: ${reason}`);
      summary.push({ id: marketId, result: `revert: ${reason}` });
    }
  }

  console.log("\n=== 彙總 ===");
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
