import { useState } from 'react'
import { formatUnits } from 'viem'
import { CITIES, CITY_NAMES, getBucketLabel, BUCKET_COUNT, type CityName } from '../lib/wagmi'
import { useMarket, useLiveWeather } from '../hooks/useMarket'
import BetModal from '../components/BetModal'

const STATUS_LABELS = ['OPEN', 'LOCKED', 'SETTLED']
const STATUS_CLASSES = ['status-open', 'status-locked', 'status-settled']

function formatPool(wei: bigint): string {
  const usdc = Number(formatUnits(wei, 6))
  if (usdc >= 1000) return `${(usdc / 1000).toFixed(1)}K`
  return usdc.toFixed(0)
}

function formatDate(ts: bigint): string {
  if (ts === 0n) return '–'
  return new Date(Number(ts) * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    hour12: false,
  }) + ' UTC'
}

interface BucketRowProps {
  index: number
  buckets: readonly bigint[]
  bucketTotal: bigint
  totalPool: bigint
  winningBucket: number
  status: number
  onBet: (bucket: number) => void
}

function BucketRow({ index, buckets, bucketTotal, totalPool, status, winningBucket, onBet }: BucketRowProps) {
  const label = getBucketLabel(buckets, index)
  const pct = totalPool > 0n ? Number((bucketTotal * 10000n) / totalPool) / 100 : 0
  const usdcAmount = formatPool(bucketTotal)
  const isWinner = status === 2 && winningBucket === index
  const isOpen = status === 0

  return (
    <div
      className={`glass-card rounded-xl p-5 flex flex-col md:flex-row items-center gap-5 transition-all duration-300 ${
        isWinner ? 'border-primary/50 bg-primary/5' : 'hover:bg-[rgba(255,255,255,0.08)]'
      }`}
    >
      <div className="w-full md:w-36 shrink-0">
        <span className="font-display text-lg font-semibold text-white">{label}</span>
        {isWinner && (
          <span className="ml-2 text-[10px] font-mono text-tertiary uppercase tracking-wider">
            ★ Winner
          </span>
        )}
      </div>

      <div className="flex-1 w-full">
        <div className="flex justify-between items-center mb-2">
          <span className="font-mono text-xs text-[rgba(255,255,255,0.5)]">
            {pct.toFixed(1)}% share
          </span>
          <span className="font-mono text-xs text-primary">{usdcAmount} USDC</span>
        </div>
        <div className="w-full h-[6px] bg-[rgba(255,255,255,0.05)] rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-1000"
            style={{ width: `${pct}%`, boxShadow: '0 0 8px rgba(0,212,255,0.4)' }}
          />
        </div>
      </div>

      <div className="w-full md:w-auto shrink-0">
        {isOpen ? (
          <button
            onClick={() => onBet(index)}
            className="w-full md:w-32 btn-outline py-3 text-sm"
          >
            Bet
          </button>
        ) : (
          <button
            disabled
            className="w-full md:w-32 py-3 text-sm border border-[rgba(255,255,255,0.1)] text-[rgba(255,255,255,0.3)] rounded-lg cursor-not-allowed"
          >
            {status === 1 ? 'Locked' : 'Settled'}
          </button>
        )}
      </div>
    </div>
  )
}

interface WeatherCardProps {
  city: CityName
  slug: string
}

function WeatherCard({ city, slug }: WeatherCardProps) {
  const weather = useLiveWeather(slug)

  return (
    <div className="glass-card animate-float rounded-2xl p-8 mb-8 grid grid-cols-1 md:grid-cols-3 items-center gap-8 relative">
      <div className="absolute top-4 right-4">
        {weather.loading ? (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[rgba(255,255,255,0.3)] animate-pulse" />
            <span className="text-[10px] font-mono text-[rgba(255,255,255,0.4)]">Loading...</span>
          </div>
        ) : weather.error && weather.offline ? (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-danger-alert" />
            <span className="text-[10px] font-mono text-danger-alert uppercase">Oracle Offline</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-tertiary animate-pulse-dot shadow-[0_0_8px_#00ff88]" />
            <span className="text-[10px] font-mono text-tertiary uppercase">Oracle Active</span>
          </div>
        )}
      </div>

      <div className="flex flex-col">
        <h1 className="font-display text-5xl font-bold text-white tracking-tight">{city}</h1>
        <p className="font-mono text-xs text-[rgba(255,255,255,0.5)] mt-1">
          OpenWeather + n8n Oracle
        </p>
      </div>

      <div className="flex justify-center items-baseline gap-2">
        {weather.temp !== null ? (
          <>
            <span className="font-display text-[80px] font-bold text-primary-container leading-none glow-text-cyan">
              {weather.temp.toFixed(1)}
            </span>
            <span className="font-display text-3xl text-primary-container glow-text-cyan">°C</span>
          </>
        ) : (
          <span className="font-display text-5xl text-[rgba(255,255,255,0.2)]">–°C</span>
        )}
      </div>

      <div className="flex flex-col md:items-end gap-3">
        {weather.humidity !== null && (
          <div className="flex items-center gap-8 md:gap-6">
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Humidity</p>
              <p className="font-display text-xl text-white">{weather.humidity}%</p>
            </div>
          </div>
        )}
        {weather.description && (
          <p className="text-xs font-mono text-[rgba(255,255,255,0.4)] capitalize">{weather.description}</p>
        )}
      </div>
    </div>
  )
}

export default function Betting() {
  const [selectedCity, setSelectedCity] = useState<CityName>('Taipei')
  const [betBucket, setBetBucket] = useState<number | null>(null)

  const city = CITIES[selectedCity]
  const { market, isLoading, refetch } = useMarket(city.marketId)

  const defaultBuckets: readonly bigint[] = [25n, 28n, 31n, 34n]
  const buckets = market?.buckets?.length ? market.buckets : defaultBuckets

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {/* City Tabs */}
      <div className="flex items-center gap-8 mb-8 overflow-x-auto no-scrollbar">
        {CITY_NAMES.map((cityName) => (
          <button
            key={cityName}
            onClick={() => setSelectedCity(cityName)}
            className="flex flex-col items-start min-w-fit group transition-all"
          >
            <span
              className={`font-display text-xl font-semibold transition-colors ${
                selectedCity === cityName
                  ? 'text-primary drop-shadow-[0_0_8px_rgba(60,215,255,0.6)]'
                  : 'text-[rgba(255,255,255,0.5)] group-hover:text-primary'
              }`}
            >
              {cityName}
            </span>
            <div
              className={`h-[2px] bg-primary mt-1 transition-all duration-300 ${
                selectedCity === cityName ? 'w-full glow-cyan' : 'w-0 group-hover:w-full'
              }`}
            />
          </button>
        ))}
      </div>

      {/* Live Weather */}
      <WeatherCard city={selectedCity} slug={city.slug} />

      {/* Market Section */}
      {isLoading ? (
        <div className="glass-card rounded-xl p-12 text-center">
          <div className="w-8 h-8 border-2 border-primary/40 border-t-primary rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[rgba(255,255,255,0.4)] font-mono text-sm">Loading market data...</p>
        </div>
      ) : market ? (
        <>
          <div className="flex flex-col md:flex-row md:items-end justify-between mb-6 gap-4">
            <div>
              <h2 className="font-display text-2xl font-bold text-white mb-1">
                Temperature Prediction – {selectedCity}
              </h2>
              <p className="text-[rgba(255,255,255,0.5)] text-sm">
                Settles at{' '}
                <span className="text-primary font-mono">{formatDate(market.lockTime)}</span>
              </p>
            </div>
            <div className="flex items-center gap-4">
              <span className={STATUS_CLASSES[market.status]}>{STATUS_LABELS[market.status]}</span>
              <div className="text-right">
                <p className="text-[10px] text-[rgba(255,255,255,0.4)] uppercase">Total Pool</p>
                <p className="font-display text-xl text-white">
                  {formatPool(market.totalPool)}{' '}
                  <span className="text-primary-container font-mono text-sm">USDC</span>
                </p>
              </div>
            </div>
          </div>

          {market.status === 2 && (
            <div className="glass-card rounded-xl p-4 mb-6 flex items-center gap-3">
              <span className="material-symbols-outlined text-tertiary">check_circle</span>
              <div>
                <span className="text-sm text-white font-semibold">Market Settled</span>
                <span className="text-[rgba(255,255,255,0.5)] text-sm ml-2">
                  Final temp:{' '}
                  <span className="text-primary font-mono">
                    {Number(market.finalTemp)}°C
                  </span>
                  {market.noWinner && ' · No winner – refunds available'}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {Array.from({ length: BUCKET_COUNT }, (_, i) => (
              <BucketRow
                key={i}
                index={i}
                buckets={buckets}
                bucketTotal={market.bucketTotals[i] ?? 0n}
                totalPool={market.totalPool}
                status={market.status}
                winningBucket={market.winningBucket}
                onBet={(b) => setBetBucket(b)}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="glass-card rounded-xl p-12 text-center">
          <span className="material-symbols-outlined text-4xl text-[rgba(255,255,255,0.2)] mb-4 block">error_outline</span>
          <p className="text-[rgba(255,255,255,0.4)] font-mono text-sm">Market not found on chain</p>
          <p className="text-[rgba(255,255,255,0.2)] font-mono text-xs mt-1">MarketId: {city.marketId.toString()}</p>
        </div>
      )}

      {/* Bet Modal */}
      {betBucket !== null && market && (
        <BetModal
          marketId={city.marketId}
          bucketIndex={betBucket}
          buckets={buckets}
          onClose={() => setBetBucket(null)}
          onSuccess={() => {
            setBetBucket(null)
            void refetch()
          }}
        />
      )}
    </div>
  )
}
