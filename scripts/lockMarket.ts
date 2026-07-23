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
  if (!raw) throw new Error("請設定環境變數 MARKET_ID，例如：MARKET_ID=0 npx hardhat run ...");
  const marketId = BigInt(raw);

  // ── 讀取部署地址 ────────────────────────────────────────────────────────────
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(
      resolve(__dirname, "../deployments/arc-testnet.json"),
      "utf-8",
    ),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  // ── 設定 viem clients ───────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  // ── 讀取市場狀態 ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, lockTime, status, totalPool] = marketData;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  console.log("Market 資訊");
  console.log("  marketId  :", marketId.toString());
  console.log("  city      :", city);
  console.log("  status    :", STATUS_LABEL[status] ?? status);
  console.log("  lockTime  :", new Date(Number(lockTime) * 1000).toISOString());
  console.log("  targetDate:", new Date(Number(targetDate) * 1000).toISOString());
  console.log("  totalPool :", (totalPool / 10n ** 6n).toString(), "USDC");

  if (status !== 0 /* OPEN */) {
    console.error(`\n錯誤：市場狀態是 ${STATUS_LABEL[status] ?? status}，只有 OPEN 狀態可以鎖盤。`);
    process.exit(1);
  }

  if (nowSec < lockTime) {
    const remaining = Number(lockTime - nowSec);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.error(`\n錯誤：鎖盤時間尚未到達，還有 ${mins} 分 ${secs} 秒。`);
    console.error(`  lockTime: ${new Date(Number(lockTime) * 1000).toISOString()}`);
    process.exit(1);
  }

  // ── 送出交易 ─────────────────────────────────────────────────────────────────
  console.log("\n鎖盤中...");
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
  console.log("等待確認...");
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("\n✓ 市場已鎖盤，不再接受下注");
  console.log("  下一步：等待 targetDate 後呼叫 submitResult");
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
