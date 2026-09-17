/**
 * Timed-out refunds: calls claimRefund on every market that is still LOCKED, past its
 * settlementDeadline, and not yet claimed by this account, then verifies the amount
 * received equals the full principal with no fee deducted.
 *
 * Usage (run as wallet B):
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

  console.log(`Network  : ${chain.name} (${chain.id})  [NETWORK=${key}]`);
  console.log(`Contract : ${WM}`);
  console.log(`Claimant : ${account.address}`);
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
    console.log(`  principal userTotalBets : ${formatUnits(stake, 6)} USDC   claimed=${claimed}`);

    if (stake === 0n) { console.log(`  skipped: no bet placed\n`); skipped++; continue; }
    if (claimed) { console.log(`  skipped: already claimed\n`); skipped++; continue; }
    if (now < deadline) {
      const left = Number(deadline - now);
      console.log(`  skipped: refund window not open, ${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m to go\n`);
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

    // ── Three independent sources, all of which avoid decimal truncation ──
    //
    // Do not compare using "6-decimal wallet balance delta + (gasWei / 1e12)": Arc's
    // native balance has 18 decimals while the ERC-20 interface has 6, so dividing
    // gasWei down to 6 decimals floors away the remainder. The result comes out one
    // smallest-unit short and looks like "the refund was 0.000001 light".
    // That false alarm was hit once for real (market #1); the amount was exactly right.

    // (1) RefundClaimed.amount as emitted by the contract itself — the authority
    const evt = receipt.logs.find(
      (l) => l.address.toLowerCase() === WM.toLowerCase() && l.data && l.data !== "0x",
    );
    const eventAmount = evt ? BigInt(evt.data) : null;

    // (2) The decrease in the contract's USDC balance
    const contractAfter = (await publicClient.readContract({
      address: USDC, abi: erc20, functionName: "balanceOf", args: [WM],
    } as any)) as bigint;
    const contractDelta = contractBefore - contractAfter;

    // (3) The claimant's native balance delta (18 decimals, no truncation) plus gas
    const nativeAfter = await publicClient.getBalance({ address: account.address });
    const nativeGross = nativeAfter - nativeBefore + gasWei;
    const stakeWei = stake * 1_000_000_000_000n;

    console.log(`  USDC before ${formatUnits(before, 6)} -> after ${formatUnits(after, 6)} (gas ${formatUnits(gasWei, 18)})`);
    console.log(`  full principal (no fee)     : ${formatUnits(stake, 6)} USDC`);
    console.log(`  (1) RefundClaimed amount    : ${eventAmount === null ? "n/a" : formatUnits(eventAmount, 6)} -> ${eventAmount === stake ? "✅" : "❌"}`);
    console.log(`  (2) contract balance delta  : ${formatUnits(contractDelta, 6)} -> ${contractDelta === stake ? "✅" : "❌"}`);
    console.log(`  (3) claimant net gain (18d) : ${formatUnits(nativeGross, 18)} -> ${nativeGross === stakeWei ? "✅" : "❌"}`);
    const allOk = eventAmount === stake && contractDelta === stake && nativeGross === stakeWei;
    console.log(`  -> ${allOk ? "✅ all three agree: full principal refunded, no 2% fee deducted" : "❌ mismatch — needs investigation"}`);

    const post = await readMarket(publicClient, WM, wmArt.abi, m.id);
    const fee = (await publicClient.readContract({
      address: WM, abi: wmArt.abi as any, functionName: "collectedFees",
    } as any)) as bigint;
    console.log(`  read back status=${STATUS_LABEL[post.status]} claimed=${await publicClient.readContract({ address: WM, abi: wmArt.abi as any, functionName: "claimed", args: [m.id, account.address] } as any)} collectedFees=${formatUnits(fee, 6)}\n`);
    done++;
  }

  console.log(`=== Summary: ${done} refunded, ${skipped} skipped ===`);
  if (done === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Error:", err.shortMessage ?? err.message);
  process.exit(1);
});
