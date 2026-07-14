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
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"];
const MARKET_IDS = [15n, 16n, 17n, 18n];

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

  const results: { id: bigint; city: string; hash: string }[] = [];

  for (const marketId of MARKET_IDS) {
    const marketData = (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "getMarket",
      args: [marketId],
    })) as [string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean];

    const [city, , lockTime, status] = marketData;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    console.log(`\nMarket #${marketId} (${city})`);
    console.log(`  status  : ${STATUS_LABEL[status] ?? status}`);

    if (status !== 0 /* OPEN */) {
      console.log(`  跳過：狀態不是 OPEN，無法鎖盤`);
      continue;
    }
    if (nowSec < lockTime) {
      console.log(`  跳過：lockTime 尚未到達 (${new Date(Number(lockTime) * 1000).toISOString()})`);
      continue;
    }

    const hash = await walletClient.writeContract({
      address: weatherMarketAddr,
      abi: artifact.abi,
      functionName: "lockMarket",
      args: [marketId],
      gas: 100_000n,
      maxPriorityFeePerGas: parseGwei("10"),
      maxFeePerGas: parseGwei("100"),
    });

    console.log(`  tx hash : ${hash}`);
    console.log(`  等待確認...`);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✓ 已鎖盤`);

    results.push({ id: marketId, city, hash });
  }

  console.log("\n=== 彙總 ===");
  for (const r of results) {
    console.log(`Market #${r.id} (${r.city}): ${r.hash}`);
  }
  if (results.length < MARKET_IDS.length) {
    console.log(
      `\n警告：只有 ${results.length}/${MARKET_IDS.length} 個市場成功鎖盤，請往上檢查跳過原因。`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
