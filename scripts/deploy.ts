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

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] },
  },
});

const GAS_OPTS = {
  gas: 3_000_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
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

  // 1. WeatherMarket（暫時以 owner 當 oracle，後面再換）
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

  // 4. MarketFactory（可選，方便之後部署更多市場）
  console.log("\n[4/4] Deploying MarketFactory...");
  const marketFactoryAddress = await deployContract(
    walletClient,
    publicClient,
    "MarketFactory",
    [usdcAddress],
  );

  // 5. 寫入 deployments/arc-testnet.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const deploymentsDir = resolve(__dirname, "../deployments");
  mkdirSync(deploymentsDir, { recursive: true });

  const deploymentData = {
    network: "Arc Testnet",
    chainId: 5042002,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    contracts: {
      WeatherMarket: weatherMarketAddress,
      AdminOracle: adminOracleAddress,
      MarketFactory: marketFactoryAddress,
      USDC: usdcAddress,
    },
  };

  const outPath = resolve(deploymentsDir, "arc-testnet.json");
  writeFileSync(outPath, JSON.stringify(deploymentData, null, 2));

  console.log("\n✓ Deployment complete. Addresses written to deployments/arc-testnet.json");
  console.log(JSON.stringify(deploymentData.contracts, null, 2));
}

main().catch((err) => {
  console.error("Deploy failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
