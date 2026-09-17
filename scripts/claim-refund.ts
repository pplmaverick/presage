/**
 * 逾時退款：對所有「LOCKED 且已過 settlementDeadline 且自己尚未領取」的市場
 * 呼叫 claimRefund，並驗證實得金額等於本金全額（不扣手續費）。
 *
 * 用法（用錢包 B 跑）：
 *   export $(cat .env.e2e | xargs)
 *   PRIVATE_KEY=$E2E_WALLET_B_KEY NETWORK=arc-testnet \
 *     ARC_RPC_URL=https://rpc.testnet.arc.io \
 *     npx hardhat run scripts/claim-refund.ts --network arc
 */
import hre from "hardhat";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, type Address } from "viem";
import {
  STATUS, STATUS_LABEL, assertChainId, computeFees,
  makeClients, readMarket, resolveNetwork, scanMarkets, sendAndConfirm,
} from "./lib/ops.js";

dotenv.config();

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const { key, chain, deploymentFile } = resolveNetwork();
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, `../deployments/${deploymentFile}`), "utf-8"),
  );
  const WM = deployments.contracts.WeatherMarket as Address;
  const USDC = deployments.contracts.USDC as Address;
  const wmArt = await hre.artifacts.readArtifact("WeatherMarket");

  const { account, walletClient, publicClient } = makeClients(chain);
  await assertChainId(publicClient, chain);
  const fees = await computeFees(publicClient);

  console.log(`網路   : ${chain.name} (${chain.id})  [NETWORK=${key}]`);
  console.log(`合約   : ${WM}`);
  console.log(`領取人 : ${account.address}`);
  console.log(`Gas    : ${fees.source} — ${fees.detail}\n`);

  const locked = await scanMarkets(publicClient, WM, wmArt.abi, STATUS.LOCKED);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const erc20 = [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
  const bal = async () => (await publicClient.readContract({
    address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address],
  } as any)) as bigint;

  let done = 0, skipped = 0;
  for (const m of locked) {
    const deadline = (await publicClient.readContract({
      address: WM, abi: wmArt.abi as any, functionName: "settlementDeadline", args: [m.id],
    } as any)) as bigint;
    const stake = (await publicClient.readContract({
      address: WM, abi: wmArt.abi as any, functionName: "userTotalBets", args: [m.id, account.address],
    } as any)) as bigint;
    const claimed = (await publicClient.readContract({
      address: WM, abi: wmArt.abi as any, functionName: "claimed", args: [m.id, account.address],
    } as any)) as boolean;

    console.log(`Market #${m.id} (${m.city}) status=${STATUS_LABEL[m.status]}`);
    console.log(`  settlementDeadline : ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);
    console.log(`  本金 userTotalBets : ${formatUnits(stake, 6)} USDC   已領取=${claimed}`);

    if (stake === 0n) { console.log(`  跳過：沒有下注\n`); skipped++; continue; }
    if (claimed) { console.log(`  跳過：已領取過\n`); skipped++; continue; }
    if (now < deadline) {
      const left = Number(deadline - now);
      console.log(`  跳過：退款窗口未開，還要 ${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m\n`);
      skipped++; continue;
    }

    const before = await bal();
    const nativeBefore = await publicClient.getBalance({ address: account.address });
    const contractBefore = (await publicClient.readContract({
      address: USDC, abi: erc20, functionName: "balanceOf", args: [WM],
    } as any)) as bigint;

    const hash = await sendAndConfirm(publicClient, walletClient, {
      address: WM, abi: wmArt.abi, functionName: "claimRefund", args: [m.id],
      gas: 300_000n, fees, label: `claimRefund(#${m.id})`,
    });

    const after = await bal();
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;

    // ── 驗證用三個獨立來源，全部避開小數位截斷 ──
    //
    // 不要用「6 位小數的錢包餘額差 + (gasWei / 1e12)」來比對：Arc 的原生餘額是
    // 18 位小數，ERC-20 介面是 6 位，把 gasWei 除到 6 位會 floor 掉餘數，
    // 算出來會比實際少 1 個最小單位，看起來就像「退款少給了 0.000001」。
    // 實測過一次假警報（市場 #1），實際金額是完全正確的。

    // (1) 合約自己 emit 的 RefundClaimed.amount —— 最權威
    const evt = receipt.logs.find(
      (l) => l.address.toLowerCase() === WM.toLowerCase() && l.data && l.data !== "0x",
    );
    const eventAmount = evt ? BigInt(evt.data) : null;

    // (2) 合約 USDC 餘額的減少量
    const contractAfter = (await publicClient.readContract({
      address: USDC, abi: erc20, functionName: "balanceOf", args: [WM],
    } as any)) as bigint;
    const contractDelta = contractBefore - contractAfter;

    // (3) 領取人原生餘額（18 位小數，不截斷）差額加回 gas
    const nativeAfter = await publicClient.getBalance({ address: account.address });
    const nativeGross = nativeAfter - nativeBefore + gasWei;
    const stakeWei = stake * 1_000_000_000_000n;

    console.log(`  USDC 前 ${formatUnits(before, 6)} → 後 ${formatUnits(after, 6)}（gas ${formatUnits(gasWei, 18)}）`);
    console.log(`  本金全額（不扣費）: ${formatUnits(stake, 6)} USDC`);
    console.log(`  ① RefundClaimed 事件金額 : ${eventAmount === null ? "n/a" : formatUnits(eventAmount, 6)} → ${eventAmount === stake ? "✅" : "❌"}`);
    console.log(`  ② 合約餘額減少量         : ${formatUnits(contractDelta, 6)} → ${contractDelta === stake ? "✅" : "❌"}`);
    console.log(`  ③ 領取人淨增（18d 精確） : ${formatUnits(nativeGross, 18)} → ${nativeGross === stakeWei ? "✅" : "❌"}`);
    const allOk = eventAmount === stake && contractDelta === stake && nativeGross === stakeWei;
    console.log(`  → ${allOk ? "✅ 三項一致，確認退還本金全額、未扣 2% 手續費" : "❌ 有不一致，需查"}`);

    const post = await readMarket(publicClient, WM, wmArt.abi, m.id);
    const fee = (await publicClient.readContract({
      address: WM, abi: wmArt.abi as any, functionName: "collectedFees",
    } as any)) as bigint;
    console.log(`  回讀 status=${STATUS_LABEL[post.status]} claimed=${await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "claimed", args: [m.id, account.address] } as any)} collectedFees=${formatUnits(fee, 6)}\n`);
    done++;
  }

  console.log(`=== 彙總：退款 ${done} 筆，跳過 ${skipped} 筆 ===`);
  if (done === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  process.exit(1);
});
