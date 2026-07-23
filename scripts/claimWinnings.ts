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
  // 用法：MARKET_ID=0 npx hardhat run scripts/claimWinnings.ts --network arc
  if (!process.env.MARKET_ID) throw new Error("請設定環境變數 MARKET_ID");
  const marketId = BigInt(process.env.MARKET_ID);

  // ── 讀取部署地址 ────────────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  // ── 設定 viem clients ───────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  // ── 讀取市場資訊 ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, , status, totalPool, , winningBucket] = marketData;

  console.log("Market 資訊");
  console.log("  marketId     :", marketId.toString());
  console.log("  city         :", city);
  console.log("  status       :", STATUS_LABEL[status] ?? status);
  console.log("  targetDate   :", new Date(Number(targetDate) * 1000).toISOString());
  console.log("  totalPool    :", (totalPool / 10n ** 6n).toString(), "USDC");
  if (status === 2) console.log("  winningBucket:", winningBucket);

  if (status !== 2 /* SETTLED */) {
    console.error(`\n錯誤：市場狀態是 ${STATUS_LABEL[status] ?? status}，只有 SETTLED 狀態可以 claim。`);
    process.exit(1);
  }

  // ── 確認是否已 claimed ────────────────────────────────────────────────────────
  const alreadyClaimed = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "claimed",
    args: [marketId, account.address],
  })) as boolean;

  if (alreadyClaimed) {
    console.error("\n錯誤：此地址已對這個市場 claim 過了。");
    process.exit(1);
  }

  // ── 送出交易 ─────────────────────────────────────────────────────────────────
  console.log("\n送出 claimWinnings...");
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
  console.log("等待確認...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── 解析 WinningsClaimed event 取得領回金額 ─────────────────────────────────────
  let payout = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== weatherMarketAddr.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "WinningsClaimed") {
        payout = (decoded.args as { amount: bigint }).amount;
      }
    } catch {
      // 非目標 event，跳過
    }
  }

  if (payout > 0n) {
    console.log(`\n✓ Claim 成功！領回 ${(payout / 10n ** 6n).toString()} USDC`);
  } else {
    console.log("\n✓ 交易確認（無法從 log 解析金額，請查 tx hash）");
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
