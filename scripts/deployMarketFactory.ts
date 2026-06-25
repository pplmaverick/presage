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
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
});

const GAS_OPTS = {
  gas: 3_000_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const usdcAddress = process.env.USDC_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  if (!usdcAddress) throw new Error("USDC_ADDRESS not set in .env");

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);
  console.log("Deploying with:", account.address);

  const walletClient = createWalletClient({
    account,
    chain: arc,
    transport: http(),
  });
  const publicClient = createPublicClient({
    chain: arc,
    transport: http(),
  });

  console.log("\nDeploying MarketFactory...");
  const artifact = await hre.artifacts.readArtifact("MarketFactory");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = await (walletClient as any).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args: [usdcAddress],
    ...GAS_OPTS,
  });
  console.log("  tx:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const marketFactoryAddress = receipt.contractAddress!;
  console.log("  MarketFactory deployed:", marketFactoryAddress);

  // 更新 deployments/arc-testnet.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const jsonPath = resolve(__dirname, "../deployments/arc-testnet.json");
  const existing = JSON.parse(readFileSync(jsonPath, "utf8"));
  existing.contracts.MarketFactory = marketFactoryAddress;
  writeFileSync(jsonPath, JSON.stringify(existing, null, 2));

  console.log("\n✓ Done. deployments/arc-testnet.json updated.");
  console.log("  MarketFactory:", marketFactoryAddress);
  console.log("  tx hash:     ", txHash);
}

main().catch((err) => {
  console.error("Deploy failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
