import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { type Chain } from 'viem'

export const arcTestnet: Chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'Arc Explorer', url: 'https://explorer.testnet.arc.network' },
  },
  testnet: true,
}

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    // retryCount: 0 — retries are handled entirely by our own rate-limit-aware backoff
    // (see withRateLimitRetry in MyBets.tsx). Leaving viem's default retryCount: 3 here
    // meant every failed request was silently retried 3x by the transport *underneath*
    // our own retry loop, multiplying the number of requests hitting an already-limited RPC.
    [arcTestnet.id]: http(
      import.meta.env.VITE_RPC_URL ?? 'https://rpc.testnet.arc.network',
      { retryCount: 0 }
    ),
  },
})

export const CONTRACT_ADDRESS = (
  import.meta.env.VITE_CONTRACT_TESTNET ?? '0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953'
) as `0x${string}`

// WeatherMarket deployment block on Arc Testnet (deployments/arc-testnet.json, deployedAt 2026-05-13T04:45:22Z).
// Confirmed via eth_getCode: no bytecode at block 41942063, bytecode present at 41942064.
export const DEPLOY_BLOCK = 41_942_064n

export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as `0x${string}`

export const ORACLE_URL =
  import.meta.env.VITE_ORACLE_URL ?? 'http://46.62.246.244:3001'

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
