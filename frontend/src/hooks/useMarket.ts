import { useReadContracts, useReadContract, usePublicClient } from 'wagmi'
import { useEffect, useState } from 'react'
import { CONTRACT_ADDRESS, BUCKET_COUNT, type CityName } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'

export interface MarketData {
  city: string
  targetDate: bigint
  lockTime: bigint
  status: number
  totalPool: bigint
  finalTemp: bigint
  winningBucket: number
  buckets: readonly bigint[]
  noWinner: boolean
  bucketTotals: bigint[]
}

export interface WeatherData {
  temp: number | null
  humidity: number | null
  description: string
  loading: boolean
  error: boolean
  offline: boolean
}

export function useMarket(marketId: bigint | undefined) {
  const bucketIndices = Array.from({ length: BUCKET_COUNT }, (_, i) => i)

  const { data: marketRaw, isLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: marketId !== undefined ? [marketId] : undefined,
    query: { enabled: marketId !== undefined },
  })

  const bucketContracts = bucketIndices.map((i) => ({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'bucketTotals' as const,
    args: [marketId ?? 0n, i] as [bigint, number],
  }))

  const { data: bucketData } = useReadContracts({
    contracts: bucketContracts,
    query: { refetchInterval: 15_000, enabled: marketId !== undefined },
  })

  const market: MarketData | null = marketRaw
    ? {
        city: marketRaw[0],
        targetDate: marketRaw[1],
        lockTime: marketRaw[2],
        status: marketRaw[3],
        totalPool: marketRaw[4],
        finalTemp: marketRaw[5],
        winningBucket: marketRaw[6],
        buckets: marketRaw[7] as readonly bigint[],
        noWinner: marketRaw[8],
        bucketTotals: bucketData
          ? bucketData.map((d) => (d.result as bigint | undefined) ?? 0n)
          : Array(BUCKET_COUNT).fill(0n),
      }
    : null

  return { market, isLoading, refetch }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The Arc testnet RPC rate-limits aggressively (observed "request limit reached"
// errors on back-to-back calls), so reads here retry with backoff instead of
// failing the whole lookup on one flaky response.
async function readWithRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (i < attempts - 1) await sleep(400 * 2 ** i)
    }
  }
  throw lastError
}

// Walks marketIds backward from the newest one, matching each city's most recent
// market. Stops as soon as every city is found, so it stays cheap (usually just
// one round's worth of reads) no matter how much chain history has piled up.
export function useLatestMarketIds(cityNames: readonly CityName[], lookback = 20) {
  const publicClient = usePublicClient()
  const [marketIds, setMarketIds] = useState<Partial<Record<CityName, bigint>>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!publicClient) return
    const client = publicClient
    let cancelled = false

    async function run() {
      setIsLoading(true)
      setError(null)
      const found: Partial<Record<CityName, bigint>> = {}
      try {
        const nextMarketId = await readWithRetry(() =>
          client.readContract({
            address: CONTRACT_ADDRESS,
            abi: WEATHER_MARKET_ABI,
            functionName: 'nextMarketId',
          })
        ) as bigint

        const remaining = new Set(cityNames)
        const floor = nextMarketId > BigInt(lookback) ? nextMarketId - BigInt(lookback) : 0n

        for (let id = nextMarketId - 1n; id >= floor && remaining.size > 0; id--) {
          if (cancelled) return
          const result = await readWithRetry(() =>
            client.readContract({
              address: CONTRACT_ADDRESS,
              abi: WEATHER_MARKET_ABI,
              functionName: 'getMarket',
              args: [id],
            })
          ) as readonly [string, ...unknown[]]

          const city = result[0] as CityName
          if (remaining.has(city)) {
            found[city] = id
            remaining.delete(city)
          }
          if (id === 0n) break
          if (remaining.size > 0) await sleep(150) // pace requests to avoid tripping the rate limit
        }
      } catch (e) {
        console.error('Failed to resolve latest markets:', e)
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to resolve latest markets')
      } finally {
        // Keep whatever cities we did resolve even if a later read in the loop failed.
        if (!cancelled) {
          setMarketIds(found)
          setIsLoading(false)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [publicClient, cityNames, lookback])

  return { marketIds, isLoading, error }
}

export function useUserBet(marketId: bigint, bucket: number, address: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'bets',
    args: address ? [marketId, bucket, address] : undefined,
    query: { enabled: !!address },
  })
}

export function useClaimed(marketId: bigint, address: `0x${string}` | undefined) {
  return useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'claimed',
    args: address ? [marketId, address] : undefined,
    query: { enabled: !!address },
  })
}

export function useLiveWeather(citySlug: string): WeatherData {
  const [data, setData] = useState<WeatherData>({
    temp: null,
    humidity: null,
    description: '',
    loading: true,
    error: false,
    offline: false,
  })

  useEffect(() => {
    let cancelled = false

    async function fetchWeather() {
      if (!cancelled) {
        setData((prev) => ({ ...prev, loading: true, error: false, offline: false }))
      }
      try {
        const res = await fetch(`/api/weather/${citySlug}`, {
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error('non-ok')
        const json = await res.json() as { temp?: number; humidity?: number; description?: string; temperature?: number }
        if (!cancelled) {
          setData({
            temp: json.temp ?? json.temperature ?? null,
            humidity: json.humidity ?? null,
            description: json.description ?? '',
            loading: false,
            error: false,
            offline: false,
          })
        }
      } catch {
        if (!cancelled) {
          setData((prev) => ({
            ...prev,
            loading: false,
            error: true,
            offline: true,
          }))
        }
      }
    }

    void fetchWeather()
    const interval = setInterval(() => void fetchWeather(), 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [citySlug])

  return data
}
