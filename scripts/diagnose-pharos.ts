/**
 * 診斷腳本：確認 Pharos Atlantic 帳戶狀態和合約狀態
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

  console.log("=== Pharos Atlantic 診斷 ===\n");

  // 1. 基本鏈資訊
  const chainId = await publicClient.getChainId();
  const blockNumber = await publicClient.getBlockNumber();
  const gasPrice = await publicClient.getGasPrice();
  console.log(`Chain ID:     ${chainId}`);
  console.log(`Block Number: ${blockNumber}`);
  console.log(`Gas Price:    ${gasPrice / BigInt(1e9)} Gwei`);

  // 2. 帳戶資訊
  const ethBalance = await publicClient.getBalance({ address: account.address });
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  console.log(`\n帳戶地址:   ${account.address}`);
  console.log(`ETH 餘額:   ${formatEther(ethBalance)} ETH`);
  console.log(`Nonce:      ${nonce}`);

  // 3. 確認合約是否真的在鏈上
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mockPath = resolve(__dirname, "../deployments/pharos-testnet-mock.json");

  if (existsSync(mockPath)) {
    const deployment = JSON.parse(readFileSync(mockPath, "utf-8"));
    const mockUsdcAddr = deployment.contracts.MockUSDC as Hex;
    const wmAddr = deployment.contracts.WeatherMarket as Hex;
    const oracleAddr = deployment.contracts.AdminOracle as Hex;

    console.log("\n--- 合約代碼存在確認 ---");
    const usdcCode = await publicClient.getCode({ address: mockUsdcAddr });
    const wmCode = await publicClient.getCode({ address: wmAddr });
    const oracleCode = await publicClient.getCode({ address: oracleAddr });

    const hasCode = (code: Hex | undefined) =>
      code && code !== "0x" ? `✓ 有代碼（${(code.length - 2) / 2} bytes）` : "✗ 無代碼（EOA 或未部署）";

    console.log(`MockUSDC    ${mockUsdcAddr}: ${hasCode(usdcCode)}`);
    console.log(`WeatherMarket ${wmAddr}: ${hasCode(wmCode)}`);
    console.log(`AdminOracle   ${oracleAddr}: ${hasCode(oracleCode)}`);

    // 4. 如果有代碼，讀取合約狀態
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
      console.log(`\nMockUSDC 狀態:`);
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
      console.log(`\nWeatherMarket 狀態:`);
      console.log(`  owner:         ${owner}`);
      console.log(`  oracle:        ${oracle}`);
      console.log(`  oracle 正確?   ${oracle.toLowerCase() === oracleAddr.toLowerCase() ? "✓ AdminOracle" : "✗ 不是 AdminOracle（可能是 deployer）"}`);
      console.log(`  nextMarketId:  ${nextMarketId}`);
    }
  } else {
    console.log("\n⚠ pharos-testnet-mock.json 不存在");
  }

  // 5. 試一次 gasEstimate（估算 mint 的 gas）
  console.log("\n--- 嘗試 gas 估算 ---");
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
        console.log(`  mint() 估算 gas: ${estimated}`);
      } else {
        console.log("  MockUSDC 無代碼，跳過估算");
      }
    }
  } catch (e: unknown) {
    const err = e as Error & { shortMessage?: string; details?: string };
    console.log(`  gas 估算失敗: ${err.shortMessage ?? err.message}`);
    if (err.details) console.log(`  Details: ${err.details}`);
  }
}

main().catch((err) => {
  console.error("診斷失敗:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
