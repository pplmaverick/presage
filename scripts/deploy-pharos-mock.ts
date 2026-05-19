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
import { writeFileSync, mkdirSync } from "node:fs";
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

const GAS_OPTS = {
  gas: 5_000_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("50"),
} as const;

async function deployContract(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  contractName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await (walletClient as any).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
    args,
    ...GAS_OPTS,
  });
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`Deploy ${contractName} reverted! tx: ${hash}`);
  }
  const address = receipt.contractAddress!;
  console.log(`  ${contractName} deployed: ${address}`);
  return address;
}

async function sendTx(
  publicClient: ReturnType<typeof createPublicClient>,
  label: string,
  hash: Hex,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`${label} reverted! tx: ${hash}`);
  }
  console.log(`  ✓ ${label}: ${hash}`);
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);
  console.log("Deploying with:", account.address);
  console.log("Network: Pharos Atlantic Testnet (Chain ID 688689)");

  const walletClient = createWalletClient({
    account,
    chain: pharosAtlantic,
    transport: http(),
  });
  const publicClient = createPublicClient({
    chain: pharosAtlantic,
    transport: http(),
  });

  // 1. MockUSDC（測試用，6 decimals）
  console.log("\n[1/5] Deploying MockUSDC...");
  const mockUsdcAddress = await deployContract(walletClient, publicClient, "MockUSDC");

  // 2. WeatherMarket（MockUSDC + owner 當初始 oracle）
  console.log("\n[2/5] Deploying WeatherMarket...");
  const weatherMarketAddress = await deployContract(
    walletClient,
    publicClient,
    "WeatherMarket",
    [mockUsdcAddress, account.address],
  );

  // 3. AdminOracle（指向 WeatherMarket）
  console.log("\n[3/5] Deploying AdminOracle...");
  const adminOracleAddress = await deployContract(
    walletClient,
    publicClient,
    "AdminOracle",
    [weatherMarketAddress],
  );

  // 4. 把 WeatherMarket 的 oracle 換成 AdminOracle
  console.log("\n[4/5] Setting oracle on WeatherMarket → AdminOracle...");
  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  await sendTx(
    publicClient,
    "setOracle",
    await walletClient.writeContract({
      address: weatherMarketAddress as Hex,
      abi: wmArtifact.abi,
      functionName: "setOracle",
      args: [adminOracleAddress],
      ...GAS_OPTS,
    }),
  );

  // 5. Mint 1000 USDC（1000 * 10^6）給部署錢包
  console.log("\n[5/5] Minting 1000 USDC to deployer...");
  const mockUsdcArtifact = await hre.artifacts.readArtifact("MockUSDC");
  await sendTx(
    publicClient,
    "mint 1000 USDC",
    await walletClient.writeContract({
      address: mockUsdcAddress as Hex,
      abi: mockUsdcArtifact.abi,
      functionName: "mint",
      args: [account.address, 1_000_000_000n], // 1000 * 10^6
      ...GAS_OPTS,
    }),
  );

  // 6. 寫入 deployments/pharos-testnet-mock.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentsDir = resolve(__dirname, "../deployments");
  mkdirSync(deploymentsDir, { recursive: true });

  const deploymentData = {
    network: "Pharos Atlantic Testnet (MockUSDC)",
    chainId: 688689,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    contracts: {
      MockUSDC: mockUsdcAddress,
      WeatherMarket: weatherMarketAddress,
      AdminOracle: adminOracleAddress,
    },
  };

  const outPath = resolve(deploymentsDir, "pharos-testnet-mock.json");
  writeFileSync(outPath, JSON.stringify(deploymentData, null, 2));

  console.log("\n✓ Deployment complete. Addresses written to deployments/pharos-testnet-mock.json");
  console.log(JSON.stringify(deploymentData.contracts, null, 2));
}

main().catch((err) => {
  console.error("Deploy failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
