/**
 * Creates a single market — creation only, no betting and no locking.
 *
 * Purpose: prepare a market for manual MetaMask testing that enters the "lockable" state
 * almost immediately, so the admin panel's Lock button display condition
 * (status == OPEN && now >= lockTime) is actually exercised.
 *
 * Environment variables:
 *   CITY            default Taipei (limited to the cities /api/weather supports)
 *   LOCK_DELAY      lockTime = now + this many seconds, default 90
 *   LOCKED_TIMEOUT  the market's settlement window, default 86400 (the contract's
 *                   MIN_LOCKED_TIMEOUT)
 *   BUCKETS         comma-separated upper bounds, default 25,28,31,34
 *
 * Usage:
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

  // Keep only the 5-argument overload so viem cannot resolve it ambiguously
  const createAbi = (wmArt.abi as any[]).filter(
    (e) => e.type === "function" && e.name === "createMarket" && e.inputs.length === 5,
  );
  if (createAbi.length !== 1) throw new Error("could not find the 5-argument createMarket");

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
    throw new Error(`lockedTimeout ${lockedTimeout} is outside [${minT}, ${maxT}]`);
  }

  const now = Math.floor(Date.now() / 1000);
  const lockTime = BigInt(now + lockDelay);
  const targetDate = lockTime + 3600n; // matches the panel: lockTime + 1 hour

  const nextId = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "nextMarketId",
  } as any)) as bigint;

  console.log(`Network   : ${chain.name} (${chain.id})  [NETWORK=${key}]`);
  console.log(`Contract  : ${WM}`);
  console.log(`Creator   : ${account.address}`);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  console.log(`Creating  : #${nextId}  city=${city}  buckets=[${buckets.join(",")}]`);
  console.log(`            lockTime=${lockTime} (${new Date(Number(lockTime) * 1000).toISOString()})`);
  console.log(`            lockedTimeout=${lockedTimeout}s\n`);

  // Preflight
  await publicClient.simulateContract({
    account: account.address, address: WM, abi: createAbi,
    functionName: "createMarket",
    args: [city, targetDate, buckets, lockTime, lockedTimeout],
  } as any);
  console.log("✓ simulateContract preflight passed");

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
  console.log(`  ✓ mined successfully (block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})\n`);

  // Read back and verify
  const m = await readMarket(publicClient, WM, wmArt.abi, nextId);
  const deadline = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "settlementDeadline", args: [nextId],
  } as any)) as bigint;
  const mt = (await publicClient.readContract({
    address: WM, abi: wmArt.abi as any, functionName: "marketLockedTimeout", args: [nextId],
  } as any)) as bigint;

  console.log(`=== On-chain read-back of #${nextId} ===`);
  console.log(`  city               : ${m.city}`);
  console.log(`  status             : ${STATUS_LABEL[m.status]}`);
  console.log(`  lockTime           : ${m.lockTime}  (${new Date(Number(m.lockTime) * 1000).toISOString()})`);
  console.log(`  targetDate         : ${m.targetDate}  (${new Date(Number(m.targetDate) * 1000).toISOString()})`);
  console.log(`  marketLockedTimeout: ${mt}`);
  console.log(`  settlementDeadline : ${deadline}  (${new Date(Number(deadline) * 1000).toISOString()})`);
  console.log(`  buckets            : [${m.buckets.join(",")}]`);
  console.log(`  totalPool          : ${formatUnits(m.totalPool, 6)} USDC`);

  const secsLeft = Number(m.lockTime) - Math.floor(Date.now() / 1000);
  console.log(`\nLockable in ${secsLeft > 0 ? `${secsLeft}s` : "0s (already lockable)"}`);
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
