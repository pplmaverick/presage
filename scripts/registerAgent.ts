/**
 * ERC-8004 AI Agent 註冊腳本
 * 文件：https://docs.arc.network/arc/tutorials/register-your-first-ai-agent
 *
 * 使用方式：
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
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
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
    `  ${ok ? "✓" : "✗"} ${label}: ${parseFloat(formatted).toFixed(6)} USDC ${ok ? "" : "← 餘額不足，請到 faucet 領取"}`,
  );
  return balance;
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // ── 1. Owner wallet（現有開發錢包）────────────────────────────────────────────
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY 未設定於 .env");
  const ownerAccount = privateKeyToAccount(`0x${privateKey}` as Hex);

  // ── 2. 生成 Validator wallet ──────────────────────────────────────────────────
  const validatorPrivKey = generatePrivateKey();
  const validatorAccount = privateKeyToAccount(validatorPrivKey);

  console.log("═══════════════════════════════════════════");
  console.log("  ERC-8004 AI Agent 註冊");
  console.log("═══════════════════════════════════════════");
  console.log("\n【錢包資訊】");
  console.log(`  Owner wallet    : ${ownerAccount.address}`);
  console.log(`  Validator wallet: ${validatorAccount.address}`);
  console.log(`  Validator privkey: ${validatorPrivKey}  ← 請立即備份！`);

  // ── 3. 設定 clients ────────────────────────────────────────────────────────────
  const publicClient = createPublicClient({ chain: arc, transport: http() });
  const ownerClient = createWalletClient({
    account: ownerAccount,
    chain: arc,
    transport: http(),
  });

  // ── 4. 確認餘額 ─────────────────────────────────────────────────────────────────
  console.log("\n【餘額確認】（需 > 0.001 USDC for gas）");
  const ownerBal     = await checkBalance(publicClient, ownerAccount.address, "Owner    ");
  const validatorBal = await checkBalance(publicClient, validatorAccount.address, "Validator");

  if (ownerBal < MIN_BALANCE) {
    console.error("\n✗ Owner 餘額不足，請到 https://faucet.arc.network 領取測試幣後再執行");
    process.exit(1);
  }

  if (validatorBal < MIN_BALANCE) {
    console.warn("\n⚠ Validator 餘額不足。");
    console.warn(`  請到 faucet 領取後傳入此地址：${validatorAccount.address}`);
    console.warn("  現在繼續執行 register()（Validator 不影響初始註冊）\n");
  }

  // ── 5. 建立 metadataURI（data URI，不需要 IPFS）──────────────────────────────
  const metadataPath = resolve(__dirname, "../metadata/weather-oracle-agent.json");
  const metadataJson = readFileSync(metadataPath, "utf-8");
  const metadataB64  = Buffer.from(metadataJson).toString("base64");
  const metadataURI  = `data:application/json;base64,${metadataB64}`;

  console.log("\n【Metadata】");
  console.log("  格式 : data URI (base64)");
  console.log("  內容 :", JSON.parse(metadataJson).name, "—", JSON.parse(metadataJson).description);

  // ── 6. 呼叫 IdentityRegistry.register() ────────────────────────────────────────
  console.log("\n【註冊 Agent】");
  console.log(`  IdentityRegistry: ${IDENTITY_REGISTRY}`);
  console.log("  送出交易...");

  const hash = await ownerClient.writeContract({
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [metadataURI],
    ...GAS_OPTS,
  });

  console.log(`  tx hash: ${hash}`);
  console.log("  等待確認...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // ── 7. 解析 agentId（Transfer event 的 tokenId）───────────────────────────────
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
    // fallback：用 tx index 推算（部分合約不 emit Transfer）
    console.warn("  警告：無法從 Transfer 事件解析 agentId，請到 explorer 手動確認");
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("  ✓ 註冊成功！");
  console.log("═══════════════════════════════════════════");
  console.log(`  agentId         : ${agentId ?? "請手動確認"}`);
  console.log(`  tx hash         : ${hash}`);
  console.log(`  block           : ${receipt.blockNumber}`);
  console.log(`  owner           : ${ownerAccount.address}`);
  console.log(`  validator addr  : ${validatorAccount.address}`);

  // ── 8. 寫入 deployments/arc-testnet.json ──────────────────────────────────────
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
  console.log("\n  → deployments/arc-testnet.json 已更新");
  console.log("\n⚠  請立即備份 Validator private key：");
  console.log(`   ${validatorPrivKey}`);
}

main().catch((err) => {
  console.error("\n✗ 錯誤：", err.shortMessage ?? err.message);
  if (err.details) console.error("  Details:", err.details);
  process.exit(1);
});
