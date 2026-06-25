import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  maxUint256,
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

const GAS_OPTS = {
  gas: 500_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

const MARKET_ID = 6n;
const USDC_DECIMALS = 6n;
const e6 = (n: number) => BigInt(n) * 10n ** USDC_DECIMALS;

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "../deployments/arc-testnet.json"), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Hex;
  const usdcAddr = deployments.contracts.USDC as Hex;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  const account = privateKeyToAccount(`0x${process.env.PRIVATE_KEY}` as Hex);
  const walletClient = createWalletClient({ account, chain: arc, transport: http() });
  const publicClient = createPublicClient({ chain: arc, transport: http() });

  console.log("WeatherMarket :", weatherMarketAddr);
  console.log("USDC          :", usdcAddr);
  console.log("marketId      :", MARKET_ID.toString());

  // 查詢 USDC 餘額
  const usdcBal = (await publicClient.readContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  console.log("USDC 餘額     :", (Number(usdcBal) / 1e6).toFixed(2), "USDC");

  if (usdcBal < e6(2)) {
    throw new Error(`USDC 不足，需要至少 2 USDC，目前 ${Number(usdcBal) / 1e6} USDC`);
  }

  // ── Approve USDC ──────────────────────────────────────────────────────────────
  console.log("\n[Approve] 授權 WeatherMarket 使用 USDC...");
  const approveHash = await walletClient.writeContract({
    address: usdcAddr,
    abi: erc20Abi,
    functionName: "approve",
    args: [weatherMarketAddr, maxUint256],
    ...GAS_OPTS,
  });
  console.log("  tx hash:", approveHash);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log("  ✓ Approve 確認");

  // ── Bet 1：bucket 1，1 USDC ──────────────────────────────────────────────────
  // bucket 1 = >28°C 且 ≤31°C
  console.log("\n[Bet 1] bucket 1 (>28°C 且 ≤31°C)，1 USDC...");
  const bet1Hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "placeBet",
    args: [MARKET_ID, 1, e6(1)],
    ...GAS_OPTS,
  });
  console.log("  tx hash:", bet1Hash);
  await publicClient.waitForTransactionReceipt({ hash: bet1Hash });
  console.log("  ✓ Bet 1 確認");

  // ── Bet 2：bucket 2，1 USDC ──────────────────────────────────────────────────
  // bucket 2 = >31°C 且 ≤34°C
  console.log("\n[Bet 2] bucket 2 (>31°C 且 ≤34°C)，1 USDC...");
  const bet2Hash = await walletClient.writeContract({
    address: weatherMarketAddr,
    abi: artifact.abi,
    functionName: "placeBet",
    args: [MARKET_ID, 2, e6(1)],
    ...GAS_OPTS,
  });
  console.log("  tx hash:", bet2Hash);
  await publicClient.waitForTransactionReceipt({ hash: bet2Hash });
  console.log("  ✓ Bet 2 確認");

  console.log("\n✅ Step 2 完成");
  console.log("  Approve tx :", approveHash);
  console.log("  Bet 1 tx   :", bet1Hash, "(bucket 1 / >28–≤31°C / 1 USDC)");
  console.log("  Bet 2 tx   :", bet2Hash, "(bucket 2 / >31–≤34°C / 1 USDC)");
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
