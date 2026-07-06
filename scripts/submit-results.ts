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

const SUBMISSIONS = [
  { marketId: 11n, finalTemp: 33n },
  { marketId: 12n, finalTemp: 26n },
  { marketId: 13n, finalTemp: 34n },
  { marketId: 14n, finalTemp: 31n },
];

async function main() {
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

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  const results: { id: bigint; city: string; finalTemp: bigint; hash: string }[] =
    [];

  for (const { marketId, finalTemp } of SUBMISSIONS) {
    const marketData = (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: wmArt.abi,
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

    const [city, , , status] = marketData;

    console.log(`\nMarket #${marketId} (${city})`);
    console.log(`  status    : ${STATUS_LABEL[status] ?? status}`);
    console.log(`  finalTemp : ${finalTemp}`);

    if (status !== 1 /* LOCKED */) {
      console.log(`  跳過：狀態不是 LOCKED，無法提交結果`);
      continue;
    }

    const hash = await walletClient.writeContract({
      address: adminOracleAddr,
      abi: aoArt.abi,
      functionName: "submitResult",
      args: [city, finalTemp, marketId],
      gas: 300_000n,
      maxPriorityFeePerGas: parseGwei("10"),
      maxFeePerGas: parseGwei("100"),
    });

    console.log(`  tx hash   : ${hash}`);
    console.log(`  等待確認...`);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✓ 結果已提交`);

    results.push({ id: marketId, city, finalTemp, hash });
  }

  console.log("\n=== 彙總 ===");
  for (const r of results) {
    console.log(
      `Market #${r.id} (${r.city}): finalTemp=${r.finalTemp} tx=${r.hash}`,
    );
  }
  if (results.length < SUBMISSIONS.length) {
    console.log(
      `\n警告：只有 ${results.length}/${SUBMISSIONS.length} 個市場成功提交，請往上檢查跳過原因。`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
