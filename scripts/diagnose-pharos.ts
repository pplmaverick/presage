/**
 * Diagnostic script: check Pharos Atlantic account and contract state
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
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

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set");

  const account = privateKeyToAccount(`0x${privateKey}` as Hex);

  const publicClient = createPublicClient({
    chain: pharosAtlantic,
    transport: http(),
  });
  const walletClient = createWalletClient({
    account,
    chain: pharosAtlantic,
    transport: http(),
  });

  console.log("=== Pharos Atlantic diagnostics ===\n");

  // 1. Basic chain info
  const chainId = await publicClient.getChainId();
  const blockNumber = await publicClient.getBlockNumber();
  const gasPrice = await publicClient.getGasPrice();
  console.log(`Chain ID:     ${chainId}`);
  console.log(`Block Number: ${blockNumber}`);
  console.log(`Gas Price:    ${gasPrice / BigInt(1e9)} Gwei`);

  // 2. Account info
  const ethBalance = await publicClient.getBalance({ address: account.address });
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  console.log(`\naccount:   ${account.address}`);
  console.log(`ETH balance: ${formatEther(ethBalance)} ETH`);
  console.log(`Nonce:      ${nonce}`);

  // 3. Confirm the contracts really are on-chain
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mockPath = resolve(__dirname, "../deployments/pharos-testnet-mock.json");

  if (existsSync(mockPath)) {
    const deployment = JSON.parse(readFileSync(mockPath, "utf-8"));
    const mockUsdcAddr = deployment.contracts.MockUSDC as Hex;
    const wmAddr = deployment.contracts.WeatherMarket as Hex;
    const oracleAddr = deployment.contracts.AdminOracle as Hex;

    console.log("\n--- contract code presence ---");
    const usdcCode = await publicClient.getCode({ address: mockUsdcAddr });
    const wmCode = await publicClient.getCode({ address: wmAddr });
    const oracleCode = await publicClient.getCode({ address: oracleAddr });

    const hasCode = (code: Hex | undefined) =>
      code && code !== "0x" ? `✓ code present (${(code.length - 2) / 2} bytes)` : "✗ no code (EOA or not deployed)";

    console.log(`MockUSDC    ${mockUsdcAddr}: ${hasCode(usdcCode)}`);
    console.log(`WeatherMarket ${wmAddr}: ${hasCode(wmCode)}`);
    console.log(`AdminOracle   ${oracleAddr}: ${hasCode(oracleCode)}`);

    // 4. If there is code, read the contract state
    if (usdcCode && usdcCode !== "0x") {
      const usdcArtifact = await hre.artifacts.readArtifact("MockUSDC");
      const balance = await publicClient.readContract({
        address: mockUsdcAddr,
        abi: usdcArtifact.abi,
        functionName: "balanceOf",
        args: [account.address],
      }) as bigint;
      const totalSupply = await publicClient.readContract({
        address: mockUsdcAddr,
        abi: usdcArtifact.abi,
        functionName: "totalSupply",
      }) as bigint;
      console.log(`\nMockUSDC state:`);
      console.log(`  totalSupply: ${Number(totalSupply) / 1e6} USDC`);
      console.log(`  deployer balance: ${Number(balance) / 1e6} USDC`);
    }

    if (wmCode && wmCode !== "0x") {
      const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
      const owner = await publicClient.readContract({
        address: wmAddr,
        abi: wmArtifact.abi,
        functionName: "owner",
      }) as Hex;
      const oracle = await publicClient.readContract({
        address: wmAddr,
        abi: wmArtifact.abi,
        functionName: "oracle",
      }) as Hex;
      const nextMarketId = await publicClient.readContract({
        address: wmAddr,
        abi: wmArtifact.abi,
        functionName: "nextMarketId",
      }) as bigint;
      console.log(`\nWeatherMarket state:`);
      console.log(`  owner:         ${owner}`);
      console.log(`  oracle:        ${oracle}`);
      console.log(`  oracle correct? ${oracle.toLowerCase() === oracleAddr.toLowerCase() ? "✓ AdminOracle" : "✗ not AdminOracle (probably the deployer)"}`);
      console.log(`  nextMarketId:  ${nextMarketId}`);
    }
  } else {
    console.log("\n⚠ pharos-testnet-mock.json does not exist");
  }

  // 5. Try a gasEstimate (for the mint call)
  console.log("\n--- attempting gas estimation ---");
  try {
    const usdcArtifact = await hre.artifacts.readArtifact("MockUSDC");
    const mockPath2 = resolve(__dirname, "../deployments/pharos-testnet-mock.json");
    if (existsSync(mockPath2)) {
      const dep = JSON.parse(readFileSync(mockPath2, "utf-8"));
      const mockUsdcAddr = dep.contracts.MockUSDC as Hex;
      const usdcCode = await publicClient.getCode({ address: mockUsdcAddr });
      if (usdcCode && usdcCode !== "0x") {
        const estimated = await publicClient.estimateContractGas({
          address: mockUsdcAddr,
          abi: usdcArtifact.abi,
          functionName: "mint",
          args: [account.address, 1_000_000_000n],
          account: account.address,
        });
        console.log(`  mint() estimated gas: ${estimated}`);
      } else {
        console.log("  MockUSDC has no code, skipping estimation");
      }
    }
  } catch (e: unknown) {
    const err = e as Error & { shortMessage?: string; details?: string };
    console.log(`  gas estimation failed: ${err.shortMessage ?? err.message}`);
    if (err.details) console.log(`  Details: ${err.details}`);
  }
}

main().catch((err) => {
  console.error("Diagnostics failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
