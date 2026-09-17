import { useReadContract, useReadContracts } from 'wagmi'
import { CONTRACT_ADDRESS } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'

export interface AdminMarket {
  id: bigint
  city: string
  targetDate: bigint
  lockTime: bigint
  status: number
  totalPool: bigint
  finalTemp: bigint
  winningBucket: number
  buckets: readonly bigint[]
  noWinner: boolean
  settlementDeadline: bigint
  lockedTimeout: bigint
}

export const STATUS_LABEL = ['OPEN', 'LOCKED', 'SETTLED'] as const

/**
 * Scans every market from 0..nextMarketId-1.
 * Deliberately no pagination or caching: the admin panel is used infrequently,
 * so correctness matters more than request count.
 */
export function useAdminMarkets() {
  const { data: nextMarketId, refetch: refetchCount } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'nextMarketId',
  })

  const count = nextMarketId ? Number(nextMarketId) : 0
  const ids = Array.from({ length: count }, (_, i) => BigInt(i))

  const contracts = ids.flatMap((id) => [
    {
      address: CONTRACT_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'getMarket' as const,
      args: [id] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'settlementDeadline' as const,
      args: [id] as const,
    },
    {
      address: CONTRACT_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'marketLockedTimeout' as const,
      args: [id] as const,
    },
  ])

  const { data, isLoading, refetch: refetchMarkets } = useReadContracts({
    contracts,
    query: { enabled: count > 0, refetchInterval: 30_000 },
  })

  const markets: AdminMarket[] = []
  if (data) {
    for (let i = 0; i < ids.length; i++) {
      const m = data[i * 3]
      const deadline = data[i * 3 + 1]
      const timeout = data[i * 3 + 2]
      if (m?.status !== 'success' || !m.result) continue
      const r = m.result as unknown as [
        string, bigint, bigint, number, bigint, bigint, number, readonly bigint[], boolean,
      ]
      markets.push({
        id: ids[i],
        city: r[0],
        targetDate: r[1],
        lockTime: r[2],
        status: Number(r[3]),
        totalPool: r[4],
        finalTemp: r[5],
        winningBucket: Number(r[6]),
        buckets: r[7],
        noWinner: r[8],
        settlementDeadline:
          deadline?.status === 'success' ? (deadline.result as bigint) : 0n,
        lockedTimeout:
          timeout?.status === 'success' ? (timeout.result as bigint) : 0n,
      })
    }
  }

  async function refetch() {
    await refetchCount()
    await refetchMarkets()
  }

  return { markets, count, isLoading, refetch }
}
