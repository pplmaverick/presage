import { useReadContracts, useReadContract } from 'wagmi'
import { useEffect, useState } from 'react'
import { CONTRACT_ADDRESS, BUCKET_COUNT } from '../lib/wagmi'
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

export function useMarket(marketId: bigint) {
  const bucketIndices = Array.from({ length: BUCKET_COUNT }, (_, i) => i)

  const { data: marketRaw, isLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: [marketId],
  })

  const bucketContracts = bucketIndices.map((i) => ({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'bucketTotals' as const,
    args: [marketId, i] as [bigint, number],
  }))

  const { data: bucketData } = useReadContracts({
    contracts: bucketContracts,
    query: { refetchInterval: 15_000 },
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
        const res = await fetch(`/api/oracle/weather/${citySlug}`, {
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
            offline: prev.temp === null,
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
