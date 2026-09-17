import hre from "hardhat";
import dotenv from "dotenv";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeDeployData, formatUnits, type Hex } from "viem";
import {
  assertChainId,
  computeFees,
  makeClients,
  resolveNetwork,
} from "./lib/ops.js";

dotenv.config();

// 部署用的 gas 不再寫死。合約長大後（SafeERC20 + claimRefund + per-market
// lockedTimeout）光 code deposit 就要 ~3.17M gas，原本寫死的 3_000_000
// 會 out-of-gas 但交易仍然上鏈、只是 status=0，白燒一次 gas。
// 一律先 estimateGas 再加 30% buffer。
const GAS_BUFFER_BPS = 13_000n;
const CALL_GAS = 200_000n;

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { key, chain, deploymentFile } = resolveNetwork();

  const usdcAddress =
    key === "arc-mainnet"
      ? (process.env.USDC_ADDRESS_MAINNET ?? "0x3600000000000000000000000000000000000000")
      : (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");

  const { account, walletClient, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);

  const fees = await computeFees(publicClient);

  console.log(`網路      : ${chain.name} (chainId ${chain.id})  [NETWORK=${key}]`);
  console.log(`部署者    : ${account.address}`);
  console.log(`USDC      : ${usdcAddress}`);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  console.log(`起始 nonce: ${await publicClient.getTransactionCount({ address: account.address })}`);
  console.log();

  async function deploy(name: string, args: readonly unknown[]) {
    const artifact = await hre.artifacts.readArtifact(name);

    const data = encodeDeployData({
      abi: artifact.abi,
      bytecode: artifact.bytecode as Hex,
      args: args as never,
    });
    const estimated = await publicClient.estimateGas({
      account: account.address,
      data,
    });
    const gas = (estimated * GAS_BUFFER_BPS) / 10_000n;
    const worstCost = gas * fees.maxFeePerGas;
    const balance = await publicClient.getBalance({ address: account.address });
    console.log(`  gas est : ${estimated} → 送出 ${gas}（+30% buffer）`);
    console.log(`  最壞成本: ${formatUnits(worstCost, 18)} USDC（餘額 ${formatUnits(balance, 18)}）`);
    if (worstCost > balance) {
      throw new Error(
        `${name} 的最壞情況成本 ${formatUnits(worstCost, 18)} USDC 超過餘額 ` +
        `${formatUnits(balance, 18)} USDC。maxFeePerGas=${fees.maxFeePerGas} wei，` +
        `請確認 gas 費用讀數是否被離群區塊拉高。`,
      );
    }

    const hash = await (walletClient as any).deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode as Hex,
      args,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    console.log(`  tx      : ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${name} 部署交易 revert：${hash}`);
    }
    console.log(`  address : ${receipt.contractAddress}`);
    console.log(`  block   : ${receipt.blockNumber}`);
    return { address: receipt.contractAddress as Hex, block: receipt.blockNumber, hash };
  }

  console.log("[1/4] WeatherMarket（先用部署者當暫時 oracle）");
  const wm = await deploy("WeatherMarket", [usdcAddress, account.address]);

  console.log("\n[2/4] AdminOracle");
  const ao = await deploy("AdminOracle", [wm.address]);

  console.log("\n[3/4] setOracle → AdminOracle");
  const wmArtifact = await hre.artifacts.readArtifact("WeatherMarket");
  const setOracleTx = await walletClient.writeContract({
    address: wm.address,
    abi: wmArtifact.abi,
    functionName: "setOracle",
    args: [ao.address],
    gas: CALL_GAS,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as never);
  console.log(`  tx      : ${setOracleTx}`);
  const setOracleReceipt = await publicClient.waitForTransactionReceipt({ hash: setOracleTx });
  if (setOracleReceipt.status !== "success") {
    throw new Error(`setOracle revert：${setOracleTx}`);
  }

  console.log("\n[4/4] MarketFactory");
  const mf = await deploy("MarketFactory", [usdcAddress]);

  // ── 部署後回讀驗證：不能只看交易成功，要確認鏈上狀態真的是預期的樣子 ──
  console.log("\n[驗證] 回讀鏈上狀態");
  const read = async (fn: string, args: readonly unknown[] = []) =>
    publicClient.readContract({
      address: wm.address,
      abi: wmArtifact.abi as any,
      functionName: fn,
      args: args as any,
    } as any);

  const onchain = {
    owner: await read("owner"),
    oracle: await read("oracle"),
    usdc: await read("usdc"),
    defaultLockedTimeout: await read("defaultLockedTimeout"),
    minLockedTimeout: await read("MIN_LOCKED_TIMEOUT"),
    maxLockedTimeout: await read("MAX_LOCKED_TIMEOUT"),
    nextMarketId: await read("nextMarketId"),
  };
  for (const [k, v] of Object.entries(onchain)) {
    console.log(`  ${k.padEnd(22)}: ${v}`);
  }
  if ((onchain.oracle as string).toLowerCase() !== ao.address.toLowerCase()) {
    throw new Error("oracle 未正確指向 AdminOracle");
  }
  if ((onchain.owner as string).toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("owner 不是部署者");
  }

  // ── 寫入 deployments/*.json（保留既有的 agent 等欄位，只換 contracts）──
  const deploymentsDir = resolve(__dirname, "../deployments");
  mkdirSync(deploymentsDir, { recursive: true });
  const outPath = resolve(deploymentsDir, deploymentFile);

  const previous = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf-8"))
    : {};

  const data = {
    ...previous,
    network: chain.name,
    chainId: chain.id,
    deployedAt: new Date().toISOString(),
    deployer: account.address,
    contracts: {
      WeatherMarket: wm.address,
      AdminOracle: ao.address,
      MarketFactory: mf.address,
      USDC: usdcAddress,
    },
    deployBlocks: {
      WeatherMarket: Number(wm.block),
      AdminOracle: Number(ao.block),
      MarketFactory: Number(mf.block),
    },
    deployTxs: {
      WeatherMarket: wm.hash,
      AdminOracle: ao.hash,
      setOracle: setOracleTx,
      MarketFactory: mf.hash,
    },
    params: {
      defaultLockedTimeout: Number(onchain.defaultLockedTimeout),
      minLockedTimeout: Number(onchain.minLockedTimeout),
      maxLockedTimeout: Number(onchain.maxLockedTimeout),
    },
    // 舊部署的紀錄留著，方便回查
    previousDeployment: previous.contracts
      ? { contracts: previous.contracts, deployedAt: previous.deployedAt }
      : undefined,
  };

  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`\n✓ 已寫入 deployments/${deploymentFile}`);
  console.log(`\n前端環境變數需同步為：`);
  const suffix = key === "arc-mainnet" ? "MAINNET" : "TESTNET";
  console.log(`  VITE_CONTRACT_${suffix}=${wm.address}`);
  console.log(`  VITE_ADMIN_ORACLE_${suffix}=${ao.address}`);
  console.log(`  VITE_DEPLOY_BLOCK_${suffix}=${wm.block}`);
}

main().catch((err) => {
  console.error("Deploy failed:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
