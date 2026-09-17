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
// Networks
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

// Defaults to testnet. Mainnet operations require an explicit NETWORK=arc-mainnet,
// so a slip of the hand cannot send a mainnet settlement to testnet or vice versa.
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
    `Unknown NETWORK="${raw}"; only arc-testnet or arc-mainnet are accepted`,
  );
}

export function makeClients(chain: Chain) {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey) throw new Error("PRIVATE_KEY is not set");
  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );
  const walletClient = createWalletClient({ account, chain, transport: http() });
  const publicClient = createPublicClient({ chain, transport: http() });
  return { account, walletClient, publicClient };
}

// Before sending any transaction, confirm the RPC's chainId really is the chain we think it is.
export async function assertChainId(publicClient: any, chain: Chain) {
  const actual = await publicClient.getChainId();
  if (actual !== chain.id) {
    throw new Error(
      `RPC chainId mismatch: expected ${chain.id} (${chain.name}), got ${actual}. Check the RPC URL.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic gas
//
// Measured on Arc mainnet (2026-09-16): baseFeePerGas floats between 20.36 and
// 20.88 gwei, the p90 tip sits at 19.5-27.3 gwei, and gasUsedRatio runs 0.25-0.74 —
// there is real competition. Testnet, by contrast, has a completely flat base fee
// pinned to the 20 gwei floor and tips that are almost always zero.
// The old hard-coded maxPriorityFeePerGas = 10 gwei was calibrated in that
// zero-competition testnet environment. On mainnet it lands below p90 and the
// transaction can sit in the mempool for a long time — which is exactly the failure
// mode behind "lockMarket / submitResult never went through and nobody noticed".
// So the fee is always queried from eth_feeHistory right before sending.
// ─────────────────────────────────────────────────────────────────────────────

export const FEE_HISTORY_BLOCKS = 10;
export const REWARD_PERCENTILE = 90;
export const TIP_BUFFER_BPS = 12_000n; // median, then +20%
export const MIN_PRIORITY_FEE = 1n * GWEI;
export const MIN_MAX_FEE = 20n * GWEI; // minFeePerGas per Arc's documentation

// Ceiling on the dynamically derived priority fee. Arc occasionally produces a block
// with an outlier tip — in a sample of the last 20 mainnet blocks one had a p90 of
// 268 gwei and another a p99 of 3839 gwei, while the base fee stayed flat at 20 gwei
// and blocks were only 8-25% full, i.e. no congestion at all.
// Without this ceiling a single outlier reading pushes maxFeePerGas into the thousands
// of gwei, and a large deployment transaction is rejected outright because
// gas * maxFee exceeds the account balance.
export const MAX_PRIORITY_FEE = 200n * GWEI;

// Conservative static values for when eth_feeHistory is unreachable. These are sized
// for mainnet, where there is real competition — not the testnet 10/100 gwei pair.
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
    if (baseFees.length === 0) throw new Error("feeHistory returned no baseFeePerGas");
    // The baseFeePerGas array is one longer than blockCount (the last entry is the
    // prediction for the next block). Taking the maximum across the window absorbs a
    // rising base fee better than reading only the most recent block.
    const baseFee = baseFees.reduce((a, b) => (a > b ? a : b), 0n);

    const perBlockP90 = (history.reward ?? []).map((row) =>
      BigInt(row?.[0] ?? "0x0"),
    );

    // Take the median of the per-block p90 tips, not the maximum.
    // The maximum is hijacked by a single outlier block (see MAX_PRIORITY_FEE); the
    // median reflects what actually has to be paid to get included.
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
        `eth_feeHistory failed (${msg}), falling back to conservative static values ` +
        `priority=${fmtGwei(FALLBACK_PRIORITY_FEE)} / maxFee=${fmtGwei(FALLBACK_MAX_FEE)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Market scanning
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

// Replaces the old hard-coded MARKET_IDS constant. Editing that constant by hand each
// round meant any market missed became one that would never be locked or settled —
// which is exactly how #31/#32 got stuck.
// The MARKET_IDS environment variable is still honoured as a manual override, e.g. to
// process only a specific few.
export async function scanMarkets(
  publicClient: any,
  address: Address,
  abi: readonly unknown[],
  wantStatus: number,
): Promise<MarketInfo[]> {
  const override = process.env.MARKET_IDS?.trim();
  if (override) {
    const ids = override.split(",").map((s) => BigInt(s.trim()));
    console.log(`MARKET_IDS override in effect, processing only: ${ids.join(", ")}`);
    const out: MarketInfo[] = [];
    for (const id of ids) out.push(await readMarket(publicClient, address, abi, id));
    return out;
  }

  const next = (await publicClient.readContract({
    address,
    abi: abi as any,
    functionName: "nextMarketId",
  } as any)) as bigint;

  console.log(`Scanning markets 0..${next - 1n} (nextMarketId=${next}), ` +
    `looking for status=${STATUS_LABEL[wantStatus]}`);

  const out: MarketInfo[] = [];
  for (let id = 0n; id < next; id++) {
    const m = await readMarket(publicClient, address, abi, id);
    if (m.status === wantStatus) out.push(m);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Send a transaction: simulate -> send -> await receipt -> check status -> read back state
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

  // Simulate first. A contract revert throws here with its revert reason attached,
  // wasting no gas and ruling out the "sent it but it actually reverted" case.
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
  console.log(`  Waiting for receipt…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // viem's receipt.status is "success" | "reverted" (the EVM's 1 / 0).
  // Getting a tx hash back is not enough — a transaction can land on-chain and revert.
  const ok = receipt.status === "success" || (receipt.status as unknown) === 1;
  if (!ok) {
    throw new Error(
      `${label} landed on-chain but reverted: receipt.status=${String(receipt.status)}, ` +
      `hash=${hash}, block=${receipt.blockNumber}`,
    );
  }

  console.log(
    `  ✓ success (block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed})`,
  );
  return hash;
}
