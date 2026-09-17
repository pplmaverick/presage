/**
 * ERC-8004 AI Agent registration script
 * Docs: https://docs.arc.network/arc/tutorials/register-your-first-ai-agent
 *
 * Usage:
 *   npx hardhat run scripts/registerAgent.ts --network arc
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseGwei,
  defineChain,
  formatUnits,
  decodeEventLog,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network"] } },
});

// IdentityRegistry（ERC-8004）
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Hex;
const IDENTITY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "Transfer",
    type: "event",
    inputs: [
      { name: "from",    type: "address", indexed: true },
      { name: "to",      type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

const GAS_OPTS = {
  gas: 1_000_000n,
  maxPriorityFeePerGas: parseGwei("10"),
  maxFeePerGas: parseGwei("100"),
} as const;

const MIN_BALANCE = 1_000_000_000_000_000n; // 0.001 USDC (18 decimals)

async function checkBalance(
  publicClient: ReturnType<typeof createPublicClient>,
  address: string,
  label: string,
): Promise<bigint> {
  const balance = await publicClient.getBalance({ address: address as Hex });
  const formatted = formatUnits(balance, 18);
  const ok = balance >= MIN_BALANCE;
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}: ${parseFloat(formatted).toFixed(6)} USDC ${ok ? "" : "← insufficient balance, top up from the faucet"}`,
  );
  return balance;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // ── 1. Owner wallet (the existing dev wallet)────────────────────────────────────────────
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY is not set in .env");
  const ownerAccount = privateKeyToAccount(`0x${privateKey}` as Hex);

  // ── 2. Generate a validator wallet ──────────────────────────────────────────────────
  const validatorPrivKey = generatePrivateKey();
  const validatorAccount = privateKeyToAccount(validatorPrivKey);

  console.log("═══════════════════════════════════════════");
  console.log("  ERC-8004 AI Agent registration");
  console.log("═══════════════════════════════════════════");
  console.log("\n[Wallet]");
  console.log(`  Owner wallet    : ${ownerAccount.address}`);
  console.log(`  Validator wallet: ${validatorAccount.address}`);
  console.log(`  Validator privkey: ${validatorPrivKey}  <- back this up now`);

  // ── 3. Set up clients ────────────────────────────────────────────────────────────
  const publicClient = createPublicClient({ chain: arc, transport: http() });
  const ownerClient = createWalletClient({
    account: ownerAccount,
    chain: arc,
    transport: http(),
  });

  // ── 4. Check balances ─────────────────────────────────────────────────────────────────
  console.log("\n[Balance check] (needs > 0.001 USDC for gas)");
  const ownerBal     = await checkBalance(publicClient, ownerAccount.address, "Owner    ");
  const validatorBal = await checkBalance(publicClient, validatorAccount.address, "Validator");

  if (ownerBal < MIN_BALANCE) {
    console.error("\n✗ Owner balance too low — get test funds from https://faucet.arc.network and retry");
    process.exit(1);
  }

  if (validatorBal < MIN_BALANCE) {
    console.warn("\n⚠ Validator balance too low.");
    console.warn(`  Fund this address from the faucet: ${validatorAccount.address}`);
    console.warn("  continuing with register() (the validator does not affect initial registration)\n");
  }

  // ── 5. Build the metadataURI (a data URI — no IPFS needed)──────────────────────────────
  const metadataPath = resolve(__dirname, "../metadata/weather-oracle-agent.json");
  const metadataJson = readFileSync(metadataPath, "utf-8");
  const metadataB64  = Buffer.from(metadataJson).toString("base64");
  const metadataURI  = `data:application/json;base64,${metadataB64}`;

  console.log("\n【Metadata】");
  console.log("  format : data URI (base64)");
  console.log("  content :", JSON.parse(metadataJson).name, "—", JSON.parse(metadataJson).description);

  // ── 6. Call IdentityRegistry.register() ────────────────────────────────────────
  console.log("\n[Register agent]");
  console.log(`  IdentityRegistry: ${IDENTITY_REGISTRY}`);
  console.log("  sending transaction...");

  const hash = await ownerClient.writeContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [metadataURI],
    ...GAS_OPTS,
  });

  console.log(`  tx hash: ${hash}`);
  console.log("  waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── 7. Parse the agentId (the Transfer event's tokenId)───────────────────────────────
  let agentId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_ABI,
        data: log.data,
        topics: log.topics,
        eventName: "Transfer",
      });
      agentId = (decoded.args as { tokenId: bigint }).tokenId;
      break;
    } catch {}
  }

  if (agentId === null) {
    // fallback: derive it from the tx index (some contracts do not emit Transfer)
    console.warn("  Warning: could not parse agentId from the Transfer event; check the explorer manually");
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✓ registered successfully");
  console.log("═══════════════════════════════════════════");
  console.log(`  agentId         : ${agentId ?? "check manually"}`);
  console.log(`  tx hash         : ${hash}`);
  console.log(`  block           : ${receipt.blockNumber}`);
  console.log(`  owner           : ${ownerAccount.address}`);
  console.log(`  validator addr  : ${validatorAccount.address}`);

  // ── 8. Write deployments/arc-testnet.json ──────────────────────────────────────
  const deploymentsPath = resolve(__dirname, "../deployments/arc-testnet.json");
  const deployments = JSON.parse(readFileSync(deploymentsPath, "utf-8"));
  deployments.agent = {
    agentId: agentId?.toString() ?? null,
    txHash: hash,
    name: "WeatherOracle",
    ownerAddress: ownerAccount.address,
    validatorAddress: validatorAccount.address,
    registeredAt: new Date().toISOString(),
  };
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("\n  -> deployments/arc-testnet.json updated");
  console.log("\n⚠  Back up the validator private key now:");
  console.log(`   ${validatorPrivKey}`);
}

main().catch((err) => {
  console.error("\n✗ Error:", err.shortMessage ?? err.message);
  if (err.details) console.error("  Details:", err.details);
  process.exit(1);
});
