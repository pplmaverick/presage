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
    [arcTestnet.id]: http(
      import.meta.env.VITE_RPC_URL ?? 'https://rpc.testnet.arc.network'
    ),
  },
})

export const CONTRACT_ADDRESS = (
  import.meta.env.VITE_CONTRACT_TESTNET ?? '0xcAC5B9d2817325E78090E3Ce4b9C299C819cF953'
) as `0x${string}`

export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as `0x${string}`

export const ORACLE_URL =
  import.meta.env.VITE_ORACLE_URL ?? 'http://46.62.246.244:3001'

export const CITIES = {
  Taipei: { marketId: 15n, slug: 'taipei' },
  Tokyo: { marketId: 16n, slug: 'tokyo' },
  Bangkok: { marketId: 17n, slug: 'bangkok' },
  Seoul: { marketId: 18n, slug: 'seoul' },
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
