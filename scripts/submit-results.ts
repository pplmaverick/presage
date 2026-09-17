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

// 每輪要提交的溫度。marketId → 整數攝氏（無 x10 編碼）。
// 也可以用環境變數覆寫，格式 RESULTS="31:33,32:27"，免得每輪都改檔案。
//
// ⚠ 這裡只放溫度，不放 city。city 一律從鏈上 getMarket 讀回來再原樣送出，
//   不由這支腳本自行組裝——手寫 city 字串正是「把 Tokyo 的溫度送進 Taipei 的
//   市場」這類錯誤的來源，而合約並不會比對 city 是否相符。
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
        throw new Error(`RESULTS 格式錯誤："${pair}"，應為 marketId:temp`);
      }
      out.set(BigInt(id), BigInt(temp));
    }
    console.log(`RESULTS 環境變數覆寫生效（${out.size} 筆）`);
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

  console.log(`網路      : ${chain.name} (chainId ${chain.id})  [NETWORK=${key}]`);
  console.log(`WeatherMarket : ${weatherMarketAddr}`);
  console.log(`AdminOracle   : ${adminOracleAddr}`);
  console.log(`簽章帳戶      : ${account.address}`);

  // AdminOracle 必須真的指向這份 WeatherMarket，否則結果會送到別的合約去
  const wired = (await publicClient.readContract({
    address: adminOracleAddr,
    abi: aoArt.abi as any,
    functionName: "weatherMarket",
  } as any)) as Address;
  if (wired.toLowerCase() !== weatherMarketAddr.toLowerCase()) {
    throw new Error(
      `AdminOracle.weatherMarket = ${wired}，與 deployment 記載的 ${weatherMarketAddr} 不符`,
    );
  }
  console.log(`  ✓ AdminOracle → WeatherMarket 指向正確`);

  const fees = await computeFees(publicClient);
  console.log(`Gas       : ${fees.source} — ${fees.detail}`);
  if (fees.source === "fallback") {
    console.log("  ⚠ 用的是保守靜態值，不是現查的市場價，請留意成本。");
  }

  const results = loadResults();

  // 自動掃描所有 LOCKED 市場，取代原本寫死的 SUBMISSIONS 陣列
  const lockedMarkets = await scanMarkets(
    publicClient,
    weatherMarketAddr,
    wmArt.abi,
    STATUS.LOCKED,
  );

  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // 結算截止時間是逐市場的（每個市場在建立當下寫入自己的 lockedTimeout），
  // 不再有全域常數可讀。
  const deadlineOf = async (id: bigint) =>
    (await publicClient.readContract({
      address: weatherMarketAddr,
      abi: wmArt.abi as any,
      functionName: "settlementDeadline",
      args: [id],
    } as any)) as bigint;

  console.log(`\nLOCKED 市場 ${lockedMarkets.length} 個`);

  const submitted: { id: bigint; city: string; temp: bigint; hash: string }[] = [];
  const failed: { id: bigint; reason: string }[] = [];
  const skippedNoTemp: bigint[] = [];
  const expired: bigint[] = [];

  for (const m of lockedMarkets) {
    const deadline = await deadlineOf(m.id);
    console.log(`\nMarket #${m.id} (${m.city})`);
    console.log(`  status    : ${STATUS_LABEL[m.status]}`);
    console.log(`  totalPool : ${Number(m.totalPool) / 1e6} USDC`);
    console.log(`  結算截止  : ${new Date(Number(deadline) * 1000).toISOString()}`);

    if (nowSec >= deadline) {
      console.log(
        `  ⛔ 結算窗口已關閉（超過該市場的 lockTime + lockedTimeout）。` +
        `此市場已轉為退款模式，使用者可自行呼叫 claimRefund(${m.id}) 取回本金。`,
      );
      expired.push(m.id);
      continue;
    }

    const temp = results.get(m.id);
    if (temp === undefined) {
      console.log(
        `  ⚠ 跳過：RESULTS 沒有提供 #${m.id} 的溫度。` +
        `補上後再跑一次（RESULTS="${m.id}:<溫度>"）。`,
      );
      skippedNoTemp.push(m.id);
      continue;
    }

    console.log(`  finalTemp : ${temp}`);
    console.log(`  city      : "${m.city}"（從鏈上讀回，非腳本組裝）`);

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

      // 回讀鏈上狀態，確認真的 SETTLED 且溫度寫入正確
      const after = await readMarket(
        publicClient,
        weatherMarketAddr,
        wmArt.abi,
        m.id,
      );
      if (after.status !== STATUS.SETTLED) {
        throw new Error(`回讀狀態為 ${STATUS_LABEL[after.status]}，預期 SETTLED`);
      }
      if (after.finalTemp !== temp) {
        throw new Error(`回讀 finalTemp=${after.finalTemp}，預期 ${temp}`);
      }
      console.log(
        `  ✓ 已確認：SETTLED, finalTemp=${after.finalTemp}, ` +
        `winningBucket=${after.winningBucket}, noWinner=${after.noWinner}`,
      );
      submitted.push({ id: m.id, city: m.city, temp, hash });
    } catch (err) {
      const reason = err instanceof Error ? (err as any).shortMessage ?? err.message : String(err);
      console.error(`  ✗ 失敗：${reason}`);
      failed.push({ id: m.id, reason });
    }
  }

  console.log("\n=== 彙總 ===");
  for (const r of submitted) {
    console.log(`Market #${r.id} (${r.city}): finalTemp=${r.temp} tx=${r.hash}`);
  }
  if (skippedNoTemp.length > 0) {
    console.log(`未提供溫度而跳過 : ${skippedNoTemp.map((i) => `#${i}`).join(", ")}`);
  }
  if (expired.length > 0) {
    console.log(`結算窗口已關閉   : ${expired.map((i) => `#${i}`).join(", ")}（改走 claimRefund）`);
  }
  if (failed.length > 0) {
    console.log(`失敗             : ${failed.map((f) => `#${f.id} (${f.reason})`).join("; ")}`);
  }

  // 有任何一個 LOCKED 市場沒被處理掉，就以非零離開——
  // 「腳本跑完沒報錯」不等於「這輪全部結算完成」。
  if (failed.length > 0 || skippedNoTemp.length > 0 || expired.length > 0) {
    console.log("\n⚠ 本輪未全數結算，請往上檢查原因。");
    process.exitCode = 1;
  } else if (submitted.length === 0) {
    console.log("\n沒有需要結算的市場。");
  }
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("Details:", err.details);
  process.exit(1);
});
