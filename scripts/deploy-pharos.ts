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
  const address = receipt.contractAddress!;
  console.log(`  ${contractName} deployed: ${address}`);
  return address;
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const usdcAddress = process.env.PHAROS_USDC_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY not set in .env");
  if (!usdcAddress) throw new Error("PHAROS_USDC_ADDRESS not set in .env");

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);
  console.log("Deploying with:", account.address);
  console.log("Network: Pharos Atlantic Testnet (Chain ID 688689)");
  console.log("USDC:", usdcAddress);

  const walletClient = createWalletClient({
    account,
    chain: pharosAtlantic,
    transport: http(),
  });
  const publicClient = createPublicClient({
    chain: pharosAtlantic,
    transport: http(),
  });

  // 1. WeatherMarket（deployer 同時是 owner 和初始 oracle）
  console.log("\n[1/3] Deploying WeatherMarket...");
  const weatherMarketAddress = await deployContract(
    walletClient,
    publicClient,
    "WeatherMarket",
    [usdcAddress, account.address],
  );

  // 2. AdminOracle（指向 WeatherMarket）
  console.log("\n[2/3] Deploying AdminOracle...");
  const adminOracleAddress = await deployContract(
    walletClient,
    publicClient,
    "AdminOracle",
    [weatherMarketAddress],
  );

  // 3. 把 WeatherMarket 的 oracle 更新為 AdminOracle
  console.log("\n[3/3] Setting oracle on WeatherMarket...");
  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const setOracleTx = await walletClient.writeContract({
    address: weatherMarketAddress as Hex,
    abi: wmArtifact.abi,
    functionName: "setOracle",
    args: [adminOracleAddress],
    ...GAS_OPTS,
  });
  await publicClient.waitForTransactionReceipt({ hash: setOracleTx });
  console.log("  oracle updated:", setOracleTx);

  // 4. 寫入 deployments/pharos-testnet.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentsDir = resolve(__dirname, "../deployments");
  mkdirSync(deploymentsDir, { recursive: true });

  const deploymentData = {
    network: "Pharos Atlantic Testnet",
    chainId: 688689,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    contracts: {
      WeatherMarket: weatherMarketAddress,
      AdminOracle: adminOracleAddress,
      USDC: usdcAddress,
    },
  };

  const outPath = resolve(deploymentsDir, "pharos-testnet.json");
  writeFileSync(outPath, JSON.stringify(deploymentData, null, 2));

  console.log("\n✓ Deployment complete. Addresses written to deployments/pharos-testnet.json");
  console.log(JSON.stringify(deploymentData.contracts, null, 2));
}

main().catch((err) => {
  console.error("Deploy failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
