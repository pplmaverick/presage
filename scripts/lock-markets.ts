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

  console.log(`網路      : ${chain.name} (chainId ${chain.id})  [NETWORK=${key}]`);
  console.log(`合約      : ${weatherMarketAddr}`);
  console.log(`簽章帳戶  : ${account.address}`);

  const fees = await computeFees(publicClient);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  if (fees.source === "fallback") {
    console.log("  ⚠ 用的是保守靜態值，不是現查的市場價，請留意成本。");
  }
  console.log();

  // 自動掃描所有 OPEN 市場，取代原本寫死的 MARKET_IDS 常數
  const open = await scanMarkets(
    publicClient,
    weatherMarketAddr,
    artifact.abi,
    STATUS.OPEN,
  );

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const due = open.filter((m) => nowSec >= m.lockTime);
  const notDue = open.filter((m) => nowSec < m.lockTime);

  console.log(`\nOPEN 市場 ${open.length} 個：可鎖 ${due.length}、未到 lockTime ${notDue.length}`);
  for (const m of notDue) {
    console.log(
      `  #${m.id} (${m.city}) lockTime ${new Date(Number(m.lockTime) * 1000).toISOString()} — 尚未到達`,
    );
  }

  if (due.length === 0) {
    console.log("\n沒有需要鎖盤的市場。");
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

      // 回讀鏈上狀態確認真的轉成 LOCKED，不是只拿到一個 tx hash
      const after = await readMarket(
        publicClient,
        weatherMarketAddr,
        artifact.abi,
        m.id,
      );
      if (after.status !== STATUS.LOCKED) {
        throw new Error(
          `回讀狀態仍為 ${STATUS_LABEL[after.status]}，預期 LOCKED`,
        );
      }
      console.log(`  ✓ 已確認鏈上狀態 = LOCKED`);
      locked.push(m.id);
    } catch (err) {
      const reason = err instanceof Error ? (err as any).shortMessage ?? err.message : String(err);
      console.error(`  ✗ 失敗：${reason}`);
      failed.push({ id: m.id, reason });
    }
  }

  console.log("\n=== 彙總 ===");
  console.log(`成功鎖盤 : ${locked.length ? locked.map((i) => `#${i}`).join(", ") : "（無）"}`);
  if (failed.length > 0) {
    console.log(`失敗     : ${failed.map((f) => `#${f.id} (${f.reason})`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
