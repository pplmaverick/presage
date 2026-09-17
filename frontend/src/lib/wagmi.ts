import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { type Chain } from 'viem'

// ─────────────────────────────────────────────────────────────────────────────
// Required environment variables
//
// There is deliberately no fallback address here. CONTRACT_ADDRESS used to carry a
// hard-coded testnet fallback, and because VITE_CONTRACT_TESTNET was never actually
// set on Vercel the frontend ran on that fallback the whole time. Shipping the same
// code to mainnet would have made the UI silently point at the testnet contract —
// the page renders, the buttons work, and the money lands on another chain.
// Failing the whole page with a config error is better than pointing at the wrong one.
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function requireEnv(name: string): string {
  const raw = (import.meta.env as Record<string, string | undefined>)[name]
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Set it on the Vercel project for Production (and Preview if you use it), then redeploy.`,
    )
  }
  return raw.trim()
}

function requireAddress(name: string): `0x${string}` {
  const v = requireEnv(name)
  if (!ADDRESS_RE.test(v)) {
    throw new Error(`Environment variable ${name} is not a valid contract address: "${v}"`)
  }
  return v as `0x${string}`
}

function requireBigInt(name: string): bigint {
  const v = requireEnv(name)
  if (!/^\d+$/.test(v)) {
    throw new Error(`Environment variable ${name} must be a decimal integer: "${v}"`)
  }
  return BigInt(v)
}

// Config errors are not thrown at module top level: that would stop React from ever
// mounting and leave the user staring at a blank page, which is harder to diagnose.
// They are collected here and main.tsx swaps in an explicit error screen instead.
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
// Chain configuration
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
    // Arc has the standard Multicall3 deployed (same address on testnet and mainnet;
    // both were confirmed to have identical code size). Without this entry wagmi's
    // useReadContracts degrades to one eth_call per contract, so opening the admin
    // panel fires 20+ concurrent requests. Arc's public node tops out at roughly 20
    // concurrent requests and returns -32005 rate limit exceeded beyond that, which
    // surfaces as three unrelated-looking symptoms: the market list showing "no
    // markets", MIN/MAX rendering as "?", and the preflight reporting "Request
    // exceeds defined limit". With multicall3 set, those reads collapse into a
    // single eth_call.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
  },
  testnet: true,
}

export const arcMainnet: Chain = {
  id: 5042,
  // Arc's own docs call mainnet simply "Arc", but this name is what the UI renders in
  // the network label. Spelling it out keeps it symmetric with "Arc Testnet" so a user
  // can never misread which chain they are spending real USDC on. chainId is what every
  // code path actually keys on; this field is display only.
  name: 'Arc Mainnet',
  // Arc's native gas token is USDC itself. Native balances are accounted in 18
  // decimals while the ERC-20 interface uses 6 — do not conflate the two.
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' },
  },
  contracts: {
    // Arc has the standard Multicall3 deployed (same address on testnet and mainnet;
    // both were confirmed to have identical code size). Without this entry wagmi's
    // useReadContracts degrades to one eth_call per contract, so opening the admin
    // panel fires 20+ concurrent requests. Arc's public node tops out at roughly 20
    // concurrent requests and returns -32005 rate limit exceeded beyond that, which
    // surfaces as three unrelated-looking symptoms: the market list showing "no
    // markets", MIN/MAX rendering as "?", and the preflight reporting "Request
    // exceeds defined limit". With multicall3 set, those reads collapse into a
    // single eth_call.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' as const },
  },
}

// VITE_NETWORK decides which chain the whole frontend talks to. It defaults to
// mainnet: if someone ships to production and forgets the variable, the result should
// be "runs on mainnet", not "silently runs on testnet".
const NETWORK = (
  (import.meta.env as Record<string, string | undefined>).VITE_NETWORK ?? 'mainnet'
).trim().toLowerCase()

export const IS_TESTNET = NETWORK === 'testnet'

if (NETWORK !== 'testnet' && NETWORK !== 'mainnet') {
  configError ??= `Environment variable VITE_NETWORK accepts only "mainnet" or "testnet", got "${NETWORK}"`
}

export const activeChain = IS_TESTNET ? arcTestnet : arcMainnet

// One set of address variables per chain, so switching network without switching
// addresses — the easiest mistake to make here — cannot happen silently.
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
    // batch: coalesce eth_calls issued within 20ms into a single JSON-RPC array
    // request (the /api/rpc proxy already accepts arrays). batchSize is held at 10
    // because Arc's node also caps the number of sub-requests inside one batch —
    // an oversized batch is rejected wholesale.
    [activeChain.id]: http('/api/rpc', {
      retryCount: 0,
      batch: { batchSize: 10, wait: 20 },
    }),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Contract addresses
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = '0x0000000000000000000000000000000000000000' as `0x${string}`

export const CONTRACT_ADDRESS = safe(
  () => requireAddress(`VITE_CONTRACT_${SUFFIX}`),
  PLACEHOLDER,
)

// WeatherMarket's deployment block. MyBets starts its eth_getLogs scan here; reusing
// the old testnet value on mainnet would scan a nonexistent range and find nothing.
export const DEPLOY_BLOCK = safe(
  () => requireBigInt(`VITE_DEPLOY_BLOCK_${SUFFIX}`),
  0n,
)

// AdminOracle — only the admin panel's "submit result" action needs this.
// Deliberately optional: ordinary users never touch it, so a missing value should not
// take the whole site down with a config-error screen. When absent, /admin shows its
// own explicit message and disables that section.
export const ADMIN_ORACLE_ADDRESS: `0x${string}` | null = (() => {
  const raw = (import.meta.env as Record<string, string | undefined>)[
    `VITE_ADMIN_ORACLE_${SUFFIX}`
  ]
  if (raw === undefined || raw.trim() === '') return null
  const v = raw.trim()
  return ADDRESS_RE.test(v) ? (v as `0x${string}`) : null
})()

// USDC has the same address on Arc mainnet and testnet (0x3600…0000, 6 decimals).
// This is the ERC-20 interface to Arc's native USDC — not a precompile; the contract
// at that address is an upgradeable proxy.
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

// For display in the UI: which variable names this chain actually reads
export const ENV_VAR_NAMES = {
  contract: `VITE_CONTRACT_${SUFFIX}`,
  deployBlock: `VITE_DEPLOY_BLOCK_${SUFFIX}`,
  adminOracle: `VITE_ADMIN_ORACLE_${SUFFIX}`,
} as const
