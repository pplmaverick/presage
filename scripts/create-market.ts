/**
 * 建立單一市場（只建，不下注、不鎖盤）。
 *
 * 用途：替手動 MetaMask 測試準備一個馬上會進入「可鎖盤」狀態的市場，
 * 讓 admin 面板的「鎖盤」按鈕顯示條件（status==OPEN && now>=lockTime）被觸發。
 *
 * 環境變數：
 *   CITY            預設 Taipei（限 /api/weather 支援的城市）
 *   LOCK_DELAY      lockTime = now + 這個秒數，預設 90
 *   LOCKED_TIMEOUT  該市場的結算期長度，預設 86400（合約下限 MIN_LOCKED_TIMEOUT）
 *   BUCKETS         逗號分隔上界，預設 25,28,31,34
 *
 * 用法：
 *   NETWORK=arc-testnet ARC_RPC_URL=https://rpc.testnet.arc.io \
 *     npx hardhat run scripts/create-market.ts --network arc
 */
import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, type Address } from "viem";
import {
  STATUS_LABEL,
  assertChainId,
  computeFees,
  makeClients,
  readMarket,
  resolveNetwork,
} from "./lib/ops.js";

dotenv.config();

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { key, chain, deploymentFile } = resolveNetwork();

  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, `../deployments/${deploymentFile}`), "utf-8"),
  );
  const WM = deployments.contracts.WeatherMarket as Address;
  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");

  // 只留 5 參數版 overload，避免 viem 解析歧義
  const createAbi = (wmArt.abi as any[]).filter(
    (e) => e.type === "function" && e.name === "createMarket" && e.inputs.length === 5,
  );
  if (createAbi.length !== 1) throw new Error("找不到 5 參數版 createMarket");

  const city = process.env.CITY ?? "Taipei";
  const lockDelay = Number(process.env.LOCK_DELAY ?? 90);
  const lockedTimeout = BigInt(process.env.LOCKED_TIMEOUT ?? 86_400);
  const buckets = (process.env.BUCKETS ?? "25,28,31,34")
    .split(",").map((s) => BigInt(s.trim()));

  const { account, walletClient, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);
  const fees = await computeFees(publicClient);

  const minT = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "MIN_LOCKED_TIMEOUT",
  } as any)) as bigint;
  const maxT = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "MAX_LOCKED_TIMEOUT",
  } as any)) as bigint;
  if (lockedTimeout < minT || lockedTimeout > maxT) {
    throw new Error(`lockedTimeout ${lockedTimeout} 超出 [${minT}, ${maxT}]`);
  }

  const now = Math.floor(Date.now() / 1000);
  const lockTime = BigInt(now + lockDelay);
  const targetDate = lockTime + 3600n; // 與面板一致：lockTime + 1 小時

  const nextId = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "nextMarketId",
  } as any)) as bigint;

  console.log(`網路      : ${chain.name} (${chain.id})  [NETWORK=${key}]`);
  console.log(`合約      : ${WM}`);
  console.log(`建立者    : ${account.address}`);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  console.log(`即將建立  : #${nextId}  city=${city}  buckets=[${buckets.join(",")}]`);
  console.log(`            lockTime=${lockTime} (${new Date(Number(lockTime) * 1000).toISOString()})`);
  console.log(`            lockedTimeout=${lockedTimeout}s\n`);

  // 預飛
  await publicClient.simulateContract({
    account: account.address, address: WM, abi: createAbi,
    functionName: "createMarket",
    args: [city, targetDate, buckets, lockTime, lockedTimeout],
  } as any);
  console.log("✓ simulateContract 預飛通過");

  const hash = await walletClient.writeContract({
    account, chain, address: WM, abi: createAbi,
    functionName: "createMarket",
    args: [city, targetDate, buckets, lockTime, lockedTimeout],
    gas: 400_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as never);
  console.log(`  tx      : ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`createMarket revert: ${hash}`);
  console.log(`  ✓ 上鏈成功 (block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})\n`);

  // 回讀驗證
  const m = await readMarket(publicClient, WM, wmArt.abi, nextId);
  const deadline = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "settlementDeadline", args: [nextId],
  } as any)) as bigint;
  const mt = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "marketLockedTimeout", args: [nextId],
  } as any)) as bigint;

  console.log(`=== 鏈上回讀 #${nextId} ===`);
  console.log(`  city               : ${m.city}`);
  console.log(`  status             : ${STATUS_LABEL[m.status]}`);
  console.log(`  lockTime           : ${m.lockTime}  (${new Date(Number(m.lockTime) * 1000).toISOString()})`);
  console.log(`  targetDate         : ${m.targetDate}  (${new Date(Number(m.targetDate) * 1000).toISOString()})`);
  console.log(`  marketLockedTimeout: ${mt}`);
  console.log(`  settlementDeadline : ${deadline}  (${new Date(Number(deadline) * 1000).toISOString()})`);
  console.log(`  buckets            : [${m.buckets.join(",")}]`);
  console.log(`  totalPool          : ${formatUnits(m.totalPool, 6)} USDC`);

  const secsLeft = Number(m.lockTime) - Math.floor(Date.now() / 1000);
  console.log(`\n距離可鎖盤還有 ${secsLeft > 0 ? `${secsLeft} 秒` : "0 秒（已可鎖盤）"}`);
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
