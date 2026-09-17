import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import {
  STATUS,
  STATUS_LABEL,
  assertChainId,
  computeFees,
  makeClients,
  readMarket,
  resolveNetwork,
  scanMarkets,
  sendAndConfirm,
} from "./lib/ops.js";

dotenv.config();

const LOCK_GAS = 120_000n;

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { key, chain, deploymentFile } = resolveNetwork();

  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, `../deployments/${deploymentFile}`), "utf-8"),
  );
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Address;
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  const { account, walletClient, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);

  console.log(`Network  : ${chain.name} (chainId ${chain.id})  [NETWORK=${key}]`);
  console.log(`Contract : ${weatherMarketAddr}`);
  console.log(`Signer   : ${account.address}`);

  const fees = await computeFees(publicClient);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  if (fees.source === "fallback") {
    console.log("  ⚠ Using conservative static values, not a live market quote — watch the cost.");
  }
  console.log();

  // Scan every OPEN market automatically, replacing the old hard-coded MARKET_IDS
  const open = await scanMarkets(
    publicClient,
    weatherMarketAddr,
    artifact.abi,
    STATUS.OPEN,
  );

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const due = open.filter((m) => nowSec >= m.lockTime);
  const notDue = open.filter((m) => nowSec < m.lockTime);

  console.log(`\n${open.length} OPEN markets: ${due.length} lockable, ${notDue.length} not yet at lockTime`);
  for (const m of notDue) {
    console.log(
      `  #${m.id} (${m.city}) lockTime ${new Date(Number(m.lockTime) * 1000).toISOString()} — not reached yet`,
    );
  }

  if (due.length === 0) {
    console.log("\nNo markets need locking.");
    return;
  }

  const locked: bigint[] = [];
  const failed: { id: bigint; reason: string }[] = [];

  for (const m of due) {
    console.log(`\nMarket #${m.id} (${m.city})`);
    console.log(`  status    : ${STATUS_LABEL[m.status]}`);
    console.log(`  lockTime  : ${new Date(Number(m.lockTime) * 1000).toISOString()}`);
    console.log(`  totalPool : ${Number(m.totalPool) / 1e6} USDC`);

    try {
      await sendAndConfirm(publicClient, walletClient, {
        address: weatherMarketAddr,
        abi: artifact.abi,
        functionName: "lockMarket",
        args: [m.id],
        gas: LOCK_GAS,
        fees,
        label: `lockMarket(#${m.id})`,
      });

      // Read the state back to confirm it really became LOCKED, not just that a tx hash came back
      const after = await readMarket(
        publicClient,
        weatherMarketAddr,
        artifact.abi,
        m.id,
      );
      if (after.status !== STATUS.LOCKED) {
        throw new Error(
          `state read back as ${STATUS_LABEL[after.status]}, expected LOCKED`,
        );
      }
      console.log(`  ✓ confirmed on-chain status = LOCKED`);
      locked.push(m.id);
    } catch (err) {
      const reason = err instanceof Error ? (err as any).shortMessage ?? err.message : String(err);
      console.error(`  ✗ failed: ${reason}`);
      failed.push({ id: m.id, reason });
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Locked : ${locked.length ? locked.map((i) => `#${i}`).join(", ") : "(none)"}`);
  if (failed.length > 0) {
    console.log(`Failed : ${failed.map((f) => `#${f.id} (${f.reason})`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
