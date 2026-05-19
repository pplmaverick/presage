/**
 * 補齊 Pharos Atlantic 設置：部署 AdminOracle + setOracle + mint USDC
 * MockUSDC 和 WeatherMarket 已存在，只需修復 oracle 和餘額
 */
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
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const pharosAtlantic = defineChain({
  id: 688689,
  name: "Pharos Atlantic Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://atlantic.dplabs-internal.com"] },
  },
});

// gas=1M × gasPrice=10gwei = 0.01 ETH 保證金（帳戶有 0.042 ETH，安全）
const GAS_OPTS = {
  gas: 1_000_000n,
  gasPrice: parseGwei("10"),
} as const;

async function sendTx(
  publicClient: ReturnType<typeof createPublicClient>,
  label: string,
  hash: Hex,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`❌ ${label} reverted! tx: ${hash}`);
  }
  console.log(`  ✓ ${label}: ${hash}`);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);
  console.log("帳戶:", account.address);

  const publicClient = createPublicClient({
    chain: pharosAtlantic,
    transport: http(),
  });
  const walletClient = createWalletClient({
    account,
    chain: pharosAtlantic,
    transport: http(),
  });

  // 讀取現有部署
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentPath = resolve(__dirname, "../deployments/pharos-testnet-mock.json");
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));

  const mockUsdcAddress = deployment.contracts.MockUSDC as Hex;
  const weatherMarketAddress = deployment.contracts.WeatherMarket as Hex;

  console.log("MockUSDC:     ", mockUsdcAddress);
  console.log("WeatherMarket:", weatherMarketAddress);

  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const usdcArtifact = await hre.artifacts.readArtifact("MockUSDC");
  const oracleArtifact = await hre.artifacts.readArtifact("AdminOracle");

  // 1. 部署 AdminOracle（指向現有 WeatherMarket）
  console.log("\n[1/3] Deploying AdminOracle...");
  const deployHash = await (walletClient as any).deployContract({
    abi: oracleArtifact.abi,
    bytecode: oracleArtifact.bytecode as Hex,
    args: [weatherMarketAddress],
    ...GAS_OPTS,
  });
  console.log("  tx:", deployHash);
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  if (deployReceipt.status === "reverted") {
    throw new Error(`AdminOracle deploy reverted! tx: ${deployHash}`);
  }
  const adminOracleAddress = deployReceipt.contractAddress!;
  console.log("  AdminOracle deployed:", adminOracleAddress);

  // 確認有代碼
  const code = await publicClient.getCode({ address: adminOracleAddress });
  if (!code || code === "0x") throw new Error("AdminOracle 部署後無代碼！");
  console.log(`  代碼確認: ${(code.length - 2) / 2} bytes`);

  // 2. setOracle：把 WeatherMarket 的 oracle 換成 AdminOracle
  console.log("\n[2/3] setOracle on WeatherMarket → AdminOracle...");
  await sendTx(
    publicClient,
    "setOracle",
    await walletClient.writeContract({
      address: weatherMarketAddress,
      abi: wmArtifact.abi,
      functionName: "setOracle",
      args: [adminOracleAddress],
      ...GAS_OPTS,
    }),
  );

  // 確認 oracle 更新
  const oracle = await publicClient.readContract({
    address: weatherMarketAddress,
    abi: wmArtifact.abi,
    functionName: "oracle",
  }) as Hex;
  if (oracle.toLowerCase() !== adminOracleAddress.toLowerCase()) {
    throw new Error(`oracle 未更新！現在是 ${oracle}`);
  }
  console.log("  oracle 確認:", oracle);

  // 3. Mint 1000 USDC 給部署錢包
  console.log("\n[3/3] Minting 1000 USDC...");
  await sendTx(
    publicClient,
    "mint 1000 USDC",
    await walletClient.writeContract({
      address: mockUsdcAddress,
      abi: usdcArtifact.abi,
      functionName: "mint",
      args: [account.address, 1_000_000_000n], // 1000 × 10^6
      ...GAS_OPTS,
    }),
  );

  const balance = await publicClient.readContract({
    address: mockUsdcAddress,
    abi: usdcArtifact.abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;
  console.log(`  餘額確認: ${Number(balance) / 1e6} USDC`);

  // 4. 更新 pharos-testnet-mock.json
  deployment.contracts.AdminOracle = adminOracleAddress;
  deployment.setupFixedAt = new Date().toISOString();
  writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("\n✓ 設置完成，已更新 pharos-testnet-mock.json");
  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((err) => {
  console.error("Setup failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
