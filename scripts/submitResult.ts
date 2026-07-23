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
  // 用法：MARKET_ID=0 TEMP=29 npx hardhat run scripts/submitResult.ts --network arc
  if (!process.env.MARKET_ID) throw new Error("請設定環境變數 MARKET_ID");
  if (!process.env.TEMP) throw new Error("請設定環境變數 TEMP（攝氏溫度整數）");
  const marketId = BigInt(process.env.MARKET_ID);
  const temp = BigInt(process.env.TEMP);

  // ── 讀取部署地址 ────────────────────────────────────────────────────────────
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

  // ── 設定 viem clients ───────────────────────────────────────────────────────
  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  // ── 讀取市場資訊 ─────────────────────────────────────────────────────────────
  const marketData = (await publicClient.readContract({
    address: weatherMarketAddr,
    abi: wmArt.abi,
    functionName: "getMarket",
    args: [marketId],
  })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

  const [city, targetDate, lockTime, status, totalPool, , , buckets] = marketData;

  console.log("Market 資訊");
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
      `\n警告：市場狀態是 ${STATUS_LABEL[status] ?? status}，不是 LOCKED。`,
    );
    console.warn("  submitResult 需要市場處於 LOCKED 狀態才會成功。");
  }

  // ── 計算得獎區間（預覽用，鏈上會再算一次）────────────────────────────────────────
  let bucketPreview = buckets.length; // 預設 >最大上界
  for (let i = 0; i < buckets.length; i++) {
    if (temp <= buckets[i]) {
      bucketPreview = i;
      break;
    }
  }
  console.log(
    `\n提交溫度 ${temp}°C → 預期得獎區間 bucket ${bucketPreview}`,
  );

  // ── 送出交易 ─────────────────────────────────────────────────────────────────
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
  console.log("等待確認...");

  await publicClient.waitForTransactionReceipt({ hash });
  console.log("✓ 結果提交成功");
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
