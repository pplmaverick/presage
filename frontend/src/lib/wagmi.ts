import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { type Chain } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// 必填環境變數
//
// 這裡刻意沒有任何 fallback 位址。過去 CONTRACT_ADDRESS 有一個硬編碼的
// testnet fallback，結果是：Vercel 上根本沒設 VITE_CONTRACT_TESTNET，前端
// 一直靠 fallback 在跑。同一份 code 部署到主網時，那個 fallback 會讓 UI
// 靜默指向 testnet 合約——使用者看得到畫面、按得下去，錢卻進了另一條鏈的
// 合約。寧可整頁顯示設定錯誤，也不要靜默指錯。
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function requireEnv(name: string): string {
  const raw = (import.meta.env as Record<string, string | undefined>)[name]
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `缺少必要環境變數 ${name}。請在 Vercel 專案的 Production 環境（以及要用的 Preview 環境）設定後重新部署。`,
    )
  }
  return raw.trim()
}

function requireAddress(name: string): `0x${string}` {
  const v = requireEnv(name)
  if (!ADDRESS_RE.test(v)) {
    throw new Error(`環境變數 ${name} 不是合法的合約位址："${v}"`)
  }
  return v as `0x${string}`
}

function requireBigInt(name: string): bigint {
  const v = requireEnv(name)
  if (!/^\d+$/.test(v)) {
    throw new Error(`環境變數 ${name} 必須是十進位整數："${v}"`)
  }
  return BigInt(v)
}

// 設定錯誤不在 module 頂層直接 throw——那樣 React 永遠掛不上去，使用者只會
// 看到一片白，反而更難查。改成收集起來，由 main.tsx 換成一頁明確的錯誤畫面。
let configError: string | null = null

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (err) {
    configError ??= err instanceof Error ? err.message : String(err)
    return fallback
  }
}

export function getConfigError(): string | null {
  return configError
}

// ─────────────────────────────────────────────────────────────────────────────
// 鏈設定
// ─────────────────────────────────────────────────────────────────────────────

export const arcTestnet: Chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  contracts: {
    // Arc 上有部署標準 Multicall3（testnet / mainnet 位址相同，實測 code size 一致）。
    // 沒有設這個的話，wagmi 的 useReadContracts 會退化成「一個 contract 一個
    // eth_call」，admin 面板開頁瞬間會噴 20+ 個並發請求，而 Arc 公開節點的
    // 並發上限實測約 20，超過就回 -32005 rate limit exceeded ——
    // 症狀是市場列表顯示「尚無市場」、MIN/MAX 顯示「?」、預飛顯示
    // 「Request exceeds defined limit」。設了之後這些讀取會收斂成單一 eth_call。
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
  },
  testnet: true,
}

export const arcMainnet: Chain = {
  id: 5042,
  name: 'Arc',
  // Arc 的原生 gas 代幣就是 USDC（原生記帳用 18 decimals；
  // ERC-20 介面的 USDC 是 6 decimals，兩者不要混淆）
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  contracts: {
    // Arc 上有部署標準 Multicall3（testnet / mainnet 位址相同，實測 code size 一致）。
    // 沒有設這個的話，wagmi 的 useReadContracts 會退化成「一個 contract 一個
    // eth_call」，admin 面板開頁瞬間會噴 20+ 個並發請求，而 Arc 公開節點的
    // 並發上限實測約 20，超過就回 -32005 rate limit exceeded ——
    // 症狀是市場列表顯示「尚無市場」、MIN/MAX 顯示「?」、預飛顯示
    // 「Request exceeds defined limit」。設了之後這些讀取會收斂成單一 eth_call。
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
  },
}

// VITE_NETWORK 決定整個前端連哪一條鏈。未設定時預設 mainnet——
// 部署到正式環境卻忘了設變數，結果應該是「跑主網」而不是「靜默跑測試網」。
const NETWORK = (
  (import.meta.env as Record<string, string | undefined>).VITE_NETWORK ?? 'mainnet'
).trim().toLowerCase()

export const IS_TESTNET = NETWORK === 'testnet'

if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  configError ??= `環境變數 VITE_NETWORK 只接受 "mainnet" 或 "testnet"，目前是 "${NETWORK}"`
}

export const activeChain = IS_TESTNET ? arcTestnet : arcMainnet

// 每條鏈各自一組位址變數，避免「切了網路但位址沒跟著切」這種最容易出事的狀況
const SUFFIX = IS_TESTNET ? 'TESTNET' : 'MAINNET' 

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  transports: {
    // retryCount: 0 — retries are handled entirely by our own rate-limit-aware backoff
    // (see withRateLimitRetry in MyBets.tsx). Leaving viem's default retryCount: 3 here
    // meant every failed request was silently retried 3x by the transport *underneath*
    // our own retry loop, multiplying the number of requests hitting an already-limited RPC.
    // Routed through our own /api/rpc proxy (frontend/api/rpc.ts) so the upstream RPC key
    // stays server-side — never bundled into client JS via a VITE_-prefixed env var.
    // batch: 把 20ms 內發出的 eth_call 併成一個 JSON-RPC 陣列請求
    // （/api/rpc 代理本來就支援陣列）。batchSize 壓在 10 是因為 Arc 節點
    // 對「單一批次內的子請求數」同樣有限額，整批太大會整批被拒。
    [activeChain.id]: http('/api/rpc', {
      retryCount: 0,
      batch: { batchSize: 10, wait: 20 },
    }),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// 合約位址
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = '0x0000000000000000000000000000000000000000' as `0x${string}`

export const CONTRACT_ADDRESS = safe(
  () => requireAddress(`VITE_CONTRACT_${SUFFIX}`),
  PLACEHOLDER,
)

// WeatherMarket 的部署區塊。MyBets 的 eth_getLogs 掃描從這裡起算，
// 沿用 testnet 的舊值會讓主網掃到一個不存在的區間或整段掃空。
export const DEPLOY_BLOCK = safe(
  () => requireBigInt(`VITE_DEPLOY_BLOCK_${SUFFIX}`),
  0n,
)

// AdminOracle —— 只有 admin 面板的「提交結果」用得到。
// 刻意做成可選：一般使用者不需要它，缺這一個不該讓整個站掛掉顯示設定錯誤畫面。
// 缺少時由 /admin 頁面自己顯示明確訊息並停用該區塊。
export const ADMIN_ORACLE_ADDRESS: `0x${string}` | null = (() => {
  const raw = (import.meta.env as Record<string, string | undefined>)[
    `VITE_ADMIN_ORACLE_${SUFFIX}`
  ]
  if (raw === undefined || raw.trim() === '') return null
  const v = raw.trim()
  return ADDRESS_RE.test(v) ? (v as `0x${string}`) : null
})()

// Arc 主網與測試網的 USDC 位址相同（0x3600…0000，6 decimals）。
// 這是 Arc 原生 USDC 的 ERC-20 介面，不是 precompile，底層是可升級代理。
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as `0x${string}`

// City -> marketId is resolved dynamically on-chain (see useLatestMarketIds in hooks/useMarket.ts),
// not hardcoded here, since a new round of markets gets created periodically as old ones settle.
export const CITIES = {
  Taipei: { slug: 'taipei' },
  Tokyo: { slug: 'tokyo' },
  Bangkok: { slug: 'bangkok' },
  Seoul: { slug: 'seoul' },
} as const

export type CityName = keyof typeof CITIES

export const CITY_NAMES = Object.keys(CITIES) as CityName[]

export function getBucketLabel(buckets: readonly bigint[], index: number): string {
  const lo = index === 0 ? null : Number(buckets[index - 1])
  const hi = index >= buckets.length ? null : Number(buckets[index])
  if (lo === null && hi !== null) return `< ${hi}°C`
  if (lo !== null && hi === null) return `> ${lo}°C`
  if (lo !== null && hi !== null) return `${lo}–${hi}°C`
  return '–'
}

export const BUCKET_COUNT = 5

// 給 UI 顯示用：目前這條鏈實際會讀哪幾個變數名
export const ENV_VAR_NAMES = {
  contract: `VITE_CONTRACT_${SUFFIX}`,
  deployBlock: `VITE_DEPLOY_BLOCK_${SUFFIX}`,
  adminOracle: `VITE_ADMIN_ORACLE_${SUFFIX}`,
} as const
