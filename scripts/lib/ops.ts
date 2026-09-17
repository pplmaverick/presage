import {
  createWalletClient,
  createPublicClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const GWEI = 1_000_000_000n;

// ─────────────────────────────────────────────────────────────────────────────
// 網路
// ─────────────────────────────────────────────────────────────────────────────

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.mainnet.arc.io"],
    },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

export type NetworkKey = "arc-testnet" | "arc-mainnet";

// 預設 testnet。主網操作必須顯式 NETWORK=arc-mainnet，避免手滑把主網結算
// 打到測試網、或反過來。
export function resolveNetwork(): {
  key: NetworkKey;
  chain: Chain;
  deploymentFile: string;
} {
  const raw = (process.env.NETWORK ?? "arc-testnet").trim();
  if (raw === "arc-mainnet") {
    return {
      key: "arc-mainnet",
      chain: arcMainnet,
      deploymentFile: "arc-mainnet.json",
    };
  }
  if (raw === "arc-testnet") {
    return {
      key: "arc-testnet",
      chain: arcTestnet,
      deploymentFile: "arc-testnet.json",
    };
  }
  throw new Error(
    `未知的 NETWORK="${raw}"，只接受 arc-testnet 或 arc-mainnet`,
  );
}

export function makeClients(chain: Chain) {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey) throw new Error("PRIVATE_KEY 未設定");
  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );
  const walletClient = createWalletClient({ account, chain, transport: http() });
  const publicClient = createPublicClient({ chain, transport: http() });
  return { account, walletClient, publicClient };
}

// 送任何交易之前先確認 RPC 回的 chainId 真的是我們以為的那條鏈。
export async function assertChainId(publicClient: any, chain: Chain) {
  const actual = await publicClient.getChainId();
  if (actual !== chain.id) {
    throw new Error(
      `RPC chainId 不符：期望 ${chain.id} (${chain.name})，實際 ${actual}。請檢查 RPC URL。`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 動態 gas
//
// Arc 主網實測（2026-09-16）：baseFeePerGas 在 20.36–20.88 gwei 之間浮動，
// tip p90 落在 19.5–27.3 gwei，gasUsedRatio 0.25–0.74（有實際競爭）。
// 測試網則是 baseFee 完全平坦貼在 20 gwei 地板、tip 幾乎恆為 0。
// 原本寫死的 maxPriorityFeePerGas = 10 gwei 是在測試網那個零競爭環境下校準的，
// 拿到主網會低於 p90，交易可能長時間卡在 mempool——而卡住又正好是
// 「lockMarket / submitResult 沒跑成功但沒人發現」那類故障的來源。
// 所以這裡一律在送出前現查 eth_feeHistory。
// ─────────────────────────────────────────────────────────────────────────────

export const FEE_HISTORY_BLOCKS = 10;
export const REWARD_PERCENTILE = 90;
export const TIP_BUFFER_BPS = 12_000n; // 取中位數後再 +20%
export const MIN_PRIORITY_FEE = 1n * GWEI;
export const MIN_MAX_FEE = 20n * GWEI; // Arc 文件記載的 minFeePerGas

// 動態算出來的 priority 上限。Arc 上偶爾會出現單一區塊的 tip 離群值
// （實測主網最近 20 塊裡有一塊 p90 = 268 gwei、另一塊 p99 = 3839 gwei，
// 但同期 baseFee 平坦在 20 gwei、gasUsedRatio 只有 8~25%，根本不壅塞）。
// 沒有這道上限的話，一次離群讀數就會讓 maxFeePerGas 飆到數千 gwei，
// 大額部署交易會因為 gas * maxFee 超過餘額而直接被拒。
export const MAX_PRIORITY_FEE = 200n * GWEI;

// eth_feeHistory 打不通時的保守靜態值（主網有實際競爭下的臨時保守值，
// 非測試網那組 10/100 gwei）。
export const FALLBACK_PRIORITY_FEE = 30n * GWEI;
export const FALLBACK_MAX_FEE = 150n * GWEI;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  source: "feeHistory" | "fallback";
  detail: string;
}

const fmtGwei = (v: bigint) => `${(Number(v) / 1e9).toFixed(3)} gwei`;

export async function computeFees(publicClient: any): Promise<Fees> {
  try {
    const history = (await publicClient.request({
      method: "eth_feeHistory" as any,
      params: [
        `0x${FEE_HISTORY_BLOCKS.toString(16)}`,
        "latest",
        [REWARD_PERCENTILE],
      ] as any,
    })) as { baseFeePerGas: Hex[]; reward?: Hex[][] };

    const baseFees = (history.baseFeePerGas ?? []).map((v) => BigInt(v));
    if (baseFees.length === 0) throw new Error("feeHistory 沒有回傳 baseFeePerGas");
    // baseFeePerGas 陣列比 blockCount 多一項（最後一項是下一塊的預測值）。
    // 取整段最大值，比只看最新一塊更能吃掉 baseFee 上行的情況。
    const baseFee = baseFees.reduce((a, b) => (a > b ? a : b), 0n);

    const perBlockP90 = (history.reward ?? []).map((row) =>
      BigInt(row?.[0] ?? "0x0"),
    );

    // 取「各塊 p90 的中位數」，不是最大值。
    // 最大值會被單一離群區塊綁架（見 MAX_PRIORITY_FEE 的說明），
    // 中位數才反映實際要付多少才會被打包。
    const sorted = [...perBlockP90].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const p90Median =
      sorted.length === 0
        ? 0n
        : sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2n;
    const p90Max = sorted.length ? sorted[sorted.length - 1] : 0n;

    let maxPriorityFeePerGas = (p90Median * TIP_BUFFER_BPS) / 10_000n;
    if (maxPriorityFeePerGas < MIN_PRIORITY_FEE) {
      maxPriorityFeePerGas = MIN_PRIORITY_FEE;
    }
    if (maxPriorityFeePerGas > MAX_PRIORITY_FEE) {
      maxPriorityFeePerGas = MAX_PRIORITY_FEE;
    }

    let maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
    if (maxFeePerGas < MIN_MAX_FEE) maxFeePerGas = MIN_MAX_FEE;

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      source: "feeHistory",
      detail:
        `baseFee(max of ${baseFees.length})=${fmtGwei(baseFee)}, ` +
        `tip p${REWARD_PERCENTILE} median=${fmtGwei(p90Median)} (max=${fmtGwei(p90Max)}, n=${perBlockP90.length}) ` +
        `→ priority=${fmtGwei(maxPriorityFeePerGas)} (+20% buffer, cap ${fmtGwei(MAX_PRIORITY_FEE)}), ` +
        `maxFee=baseFee*2+priority=${fmtGwei(maxFeePerGas)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      maxFeePerGas: FALLBACK_MAX_FEE,
      maxPriorityFeePerGas: FALLBACK_PRIORITY_FEE,
      source: "fallback",
      detail:
        `eth_feeHistory 失敗（${msg}），改用保守靜態值 ` +
        `priority=${fmtGwei(FALLBACK_PRIORITY_FEE)} / maxFee=${fmtGwei(FALLBACK_MAX_FEE)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 市場掃描
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS = { OPEN: 0, LOCKED: 1, SETTLED: 2 } as const;
export const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"] as const;

export interface MarketInfo {
  id: bigint;
  city: string;
  targetDate: bigint;
  lockTime: bigint;
  status: number;
  totalPool: bigint;
  finalTemp: bigint;
  winningBucket: number;
  buckets: bigint[];
  noWinner: boolean;
}

export async function readMarket(
  publicClient: any,
  address: Address,
  abi: readonly unknown[],
  id: bigint,
): Promise<MarketInfo> {
  const m = (await publicClient.readContract({
    address,
    abi: abi as any,
    functionName: "getMarket",
    args: [id],
  } as any)) as [
    string, bigint, bigint, number, bigint, bigint, number, bigint[], boolean,
  ];
  return {
    id,
    city: m[0],
    targetDate: m[1],
    lockTime: m[2],
    status: Number(m[3]),
    totalPool: m[4],
    finalTemp: m[5],
    winningBucket: Number(m[6]),
    buckets: m[7],
    noWinner: m[8],
  };
}

// 取代原本寫死的 MARKET_IDS 常數。每輪手動改常數，漏掉一個市場就是一個
// 永遠不會被鎖/結算的市場（#31/#32 就是這樣卡住的）。
// 仍保留 MARKET_IDS 環境變數做手動覆寫（例如只想處理特定幾個）。
export async function scanMarkets(
  publicClient: any,
  address: Address,
  abi: readonly unknown[],
  wantStatus: number,
): Promise<MarketInfo[]> {
  const override = process.env.MARKET_IDS?.trim();
  if (override) {
    const ids = override.split(",").map((s) => BigInt(s.trim()));
    console.log(`MARKET_IDS 覆寫生效，只處理：${ids.join(", ")}`);
    const out: MarketInfo[] = [];
    for (const id of ids) out.push(await readMarket(publicClient, address, abi, id));
    return out;
  }

  const next = (await publicClient.readContract({
    address,
    abi: abi as any,
    functionName: "nextMarketId",
  } as any)) as bigint;

  console.log(`掃描市場 0 … ${next - 1n}（nextMarketId=${next}），` +
    `尋找 status=${STATUS_LABEL[wantStatus]}`);

  const out: MarketInfo[] = [];
  for (let id = 0n; id < next; id++) {
    const m = await readMarket(publicClient, address, abi, id);
    if (m.status === wantStatus) out.push(m);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 送交易：模擬 → 送出 → 等收據 → 驗證 status → 回讀鏈上狀態
// ─────────────────────────────────────────────────────────────────────────────

export async function sendAndConfirm(
  publicClient: any,
  walletClient: any,
  params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    gas: bigint;
    fees: Fees;
    label: string;
  },
): Promise<Hex> {
  const { address, abi, functionName, args, gas, fees, label } = params;

  // 先模擬。合約 revert 在這裡就會拋出並帶回 revert reason，
  // 不會浪費 gas，也不會出現「送出去了但其實 revert」的情況。
  await publicClient.simulateContract({
    account: walletClient.account!,
    address,
    abi: abi as any,
    functionName,
    args: args as any,
  });

  const hash = await walletClient.writeContract({
    account: walletClient.account!,
    chain: walletClient.chain,
    address,
    abi: abi as any,
    functionName,
    args: args as any,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  } as any);

  console.log(`  tx hash   : ${hash}`);
  console.log(`  等待收據…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // viem 的 receipt.status 是 "success" | "reverted"（對應 EVM 的 1 / 0）。
  // 只確認「拿得到 tx hash」是不夠的——交易可以順利上鏈然後 revert。
  const ok = receipt.status === "success" || (receipt.status as unknown) === 1;
  if (!ok) {
    throw new Error(
      `${label} 交易已上鏈但 revert：receipt.status=${String(receipt.status)}, ` +
      `hash=${hash}, block=${receipt.blockNumber}`,
    );
  }

  console.log(
    `  ✓ 成功（block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}）`,
  );
  return hash;
}
