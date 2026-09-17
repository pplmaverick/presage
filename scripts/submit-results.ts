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

const SUBMIT_GAS = 300_000n;

// Temperatures to submit this round. marketId -> whole degrees Celsius (no x10 encoding).
// Can also be overridden with an environment variable, RESULTS="31:33,32:27", so the
// file does not have to be edited every round.
//
// ⚠ Temperatures only — never city. The city is always read back from getMarket on-chain
//   and passed through unchanged; this script never assembles it. A hand-typed city
//   string is exactly how "Tokyo's temperature submitted to Taipei's market" happens,
//   and the contract does not check that city matches the market.
const RESULTS: Record<string, number> = {
  // "31": 33,
  // "32": 27,
};

function loadResults(): Map<bigint, bigint> {
  const out = new Map<bigint, bigint>();
  for (const [id, temp] of Object.entries(RESULTS)) {
    out.set(BigInt(id), BigInt(temp));
  }
  const env = process.env.RESULTS?.trim();
  if (env) {
    for (const pair of env.split(",")) {
      const [id, temp] = pair.split(":").map((s) => s.trim());
      if (!id || temp === undefined) {
        throw new Error(`Malformed RESULTS entry "${pair}"; expected marketId:temp`);
      }
      out.set(BigInt(id), BigInt(temp));
    }
    console.log(`RESULTS environment override in effect (${out.size} entries)`);
  }
  return out;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { key, chain, deploymentFile } = resolveNetwork();

  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, `../deployments/${deploymentFile}`), "utf-8"),
  );
  const adminOracleAddr = deployments.contracts.AdminOracle as Address;
  const weatherMarketAddr = deployments.contracts.WeatherMarket as Address;

  const aoArt = await hre.artifacts.readArtifact("AdminOracle");
  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");

  const { account, walletClient, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);

  console.log(`Network       : ${chain.name} (chainId ${chain.id})  [NETWORK=${key}]`);
  console.log(`WeatherMarket : ${weatherMarketAddr}`);
  console.log(`AdminOracle   : ${adminOracleAddr}`);
  console.log(`Signer        : ${account.address}`);

  // AdminOracle must actually point at this WeatherMarket, or the result goes elsewhere
  const wired = (await publicClient.readContract({
    address: adminOracleAddr,
    abi: aoArt.abi as any,
    functionName: "weatherMarket",
  } as any)) as Address;
  if (wired.toLowerCase() !== weatherMarketAddr.toLowerCase()) {
    throw new Error(
      `AdminOracle.weatherMarket = ${wired} does not match ${weatherMarketAddr} from the deployment record`,
    );
  }
  console.log(`  ✓ AdminOracle -> WeatherMarket wiring is correct`);

  const fees = await computeFees(publicClient);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  if (fees.source === "fallback") {
    console.log("  ⚠ Using conservative static values, not a live market quote — watch the cost.");
  }

  const results = loadResults();

  // Scan every LOCKED market automatically, replacing the old hard-coded SUBMISSIONS array
  const lockedMarkets = await scanMarkets(
    publicClient,
    weatherMarketAddr,
    wmArt.abi,
    STATUS.LOCKED,
  );

  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // The settlement deadline is per-market (each market stores its own lockedTimeout at
  // creation); there is no longer a global constant to read.
  const deadlineOf = async (id: bigint) =>
    (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: wmArt.abi as any,
      functionName: "settlementDeadline",
      args: [id],
    } as any)) as bigint;

  console.log(`\n${lockedMarkets.length} LOCKED markets`);

  const submitted: { id: bigint; city: string; temp: bigint; hash: string }[] = [];
  const failed: { id: bigint; reason: string }[] = [];
  const skippedNoTemp: bigint[] = [];
  const expired: bigint[] = [];

  for (const m of lockedMarkets) {
    const deadline = await deadlineOf(m.id);
    console.log(`\nMarket #${m.id} (${m.city})`);
    console.log(`  status    : ${STATUS_LABEL[m.status]}`);
    console.log(`  totalPool : ${Number(m.totalPool) / 1e6} USDC`);
    console.log(`  deadline  : ${new Date(Number(deadline) * 1000).toISOString()}`);

    if (nowSec >= deadline) {
      console.log(
        `  ⛔ Settlement window closed (past this market's lockTime + lockedTimeout). ` +
        `It is now in refund mode; bettors can call claimRefund(${m.id}) to reclaim their principal.`,
      );
      expired.push(m.id);
      continue;
    }

    const temp = results.get(m.id);
    if (temp === undefined) {
      console.log(
        `  ⚠ Skipped: RESULTS has no temperature for #${m.id}. ` +
        `Add it and run again (RESULTS="${m.id}:<temp>").`,
      );
      skippedNoTemp.push(m.id);
      continue;
    }

    console.log(`  finalTemp : ${temp}`);
    console.log(`  city      : "${m.city}" (read on-chain, not assembled by this script)`);

    try {
      const hash = await sendAndConfirm(publicClient, walletClient, {
        address: adminOracleAddr,
        abi: aoArt.abi,
        functionName: "submitResult",
        args: [m.city, temp, m.id],
        gas: SUBMIT_GAS,
        fees,
        label: `submitResult(#${m.id})`,
      });

      // Read the state back to confirm it really is SETTLED and the temperature landed
      const after = await readMarket(
        publicClient,
        weatherMarketAddr,
        wmArt.abi,
        m.id,
      );
      if (after.status !== STATUS.SETTLED) {
        throw new Error(`state read back as ${STATUS_LABEL[after.status]}, expected SETTLED`);
      }
      if (after.finalTemp !== temp) {
        throw new Error(`finalTemp read back as ${after.finalTemp}, expected ${temp}`);
      }
      console.log(
        `  ✓ confirmed: SETTLED, finalTemp=${after.finalTemp}, ` +
        `winningBucket=${after.winningBucket}, noWinner=${after.noWinner}`,
      );
      submitted.push({ id: m.id, city: m.city, temp, hash });
    } catch (err) {
      const reason = err instanceof Error ? (err as any).shortMessage ?? err.message : String(err);
      console.error(`  ✗ failed: ${reason}`);
      failed.push({ id: m.id, reason });
    }
  }

  console.log("\n=== Summary ===");
  for (const r of submitted) {
    console.log(`Market #${r.id} (${r.city}): finalTemp=${r.temp} tx=${r.hash}`);
  }
  if (skippedNoTemp.length > 0) {
    console.log(`Skipped, no temperature : ${skippedNoTemp.map((i) => `#${i}`).join(", ")}`);
  }
  if (expired.length > 0) {
    console.log(`Settlement window closed: ${expired.map((i) => `#${i}`).join(", ")} (use claimRefund instead)`);
  }
  if (failed.length > 0) {
    console.log(`Failed                  : ${failed.map((f) => `#${f.id} (${f.reason})`).join("; ")}`);
  }

  // Exit non-zero if any LOCKED market went unhandled — "the script finished without
  // errors" is not the same as "everything settled this round".
  if (failed.length > 0 || skippedNoTemp.length > 0 || expired.length > 0) {
    console.log("\n⚠ Not everything settled this round — check the reasons above.");
    process.exitCode = 1;
  } else if (submitted.length === 0) {
    console.log("\nNo markets need settling.");
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
