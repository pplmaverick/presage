import { formatUnits } from 'viem'
import { CITY_NAMES, CONTRACT_ADDRESS, getBucketLabel, BUCKET_COUNT, type CityName } from '../lib/wagmi'
import { useMarket, useLatestMarketIds } from '../hooks/useMarket'

const STATUS_LABELS = ['OPEN', 'LOCKED', 'SETTLED']
const STATUS_CLASSES = ['status-open', 'status-locked', 'status-settled']

function formatPool(wei: bigint): string {
  const usdc = Number(formatUnits(wei, 6))
  if (usdc >= 1000) return `${(usdc / 1000).toFixed(2)}K`
  return usdc.toFixed(2)
}

function formatDateShort(ts: bigint): string {
  if (ts === 0n) return '–'
  return new Date(Number(ts) * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', hour12: false,
  }) + ' UTC'
}

interface CityMarketCardProps {
  cityName: CityName
  marketId: bigint | undefined
  isResolvingMarket: boolean
}

function CityMarketCard({ cityName, marketId, isResolvingMarket }: CityMarketCardProps) {
  const { market, isLoading: isLoadingMarket } = useMarket(marketId)
  const isLoading = isResolvingMarket || isLoadingMarket

  const defaultBuckets: readonly bigint[] = [25n, 28n, 31n, 34n]
  const buckets = market?.buckets?.length ? market.buckets : defaultBuckets

  return (
    <div className="glass-card rounded-2xl overflow-hidden transition-transform hover:scale-[1.01]">
      {/* Card Header */}
      <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between">
        <div>
          <h3 className="font-display text-xl font-bold text-white">{cityName}</h3>
          <p className="font-mono text-[10px] text-[rgba(255,255,255,0.3)] mt-0.5">
            {marketId !== undefined ? `Market #${marketId.toString()}` : 'Resolving market…'}
          </p>
        </div>
        {isLoading ? (
          <div className="w-5 h-5 border border-primary/40 border-t-primary rounded-full animate-spin" />
        ) : market ? (
          <span className={STATUS_CLASSES[market.status]}>{STATUS_LABELS[market.status]}</span>
        ) : (
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.2)]">No data</span>
        )}
      </div>

      {!isLoading && market && (
        <div className="px-6 py-5 space-y-4">
          {/* Pool info */}
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Total Pool</span>
            <span className="font-mono text-sm text-primary">{formatPool(market.totalPool)} USDC</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Lock Time</span>
            <span className="font-mono text-xs text-[rgba(255,255,255,0.6)]">{formatDateShort(market.lockTime)}</span>
          </div>

          {/* Settled info */}
          {market.status === 2 && (
            <div className="p-3 bg-[rgba(168,232,255,0.05)] border border-[rgba(168,232,255,0.15)] rounded-lg">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Final Temp</span>
                <span className="font-display text-xl font-bold text-primary glow-text-cyan">
                  {Number(market.finalTemp)}°C
                </span>
              </div>
              {market.noWinner ? (
                <p className="text-[10px] text-warning-locked mt-2">No winner — refunds available</p>
              ) : (
                <div className="flex justify-between items-center mt-2">
                  <span className="text-[10px] font-mono text-[rgba(255,255,255,0.4)]">Winning Bucket</span>
                  <span className="text-xs font-mono text-tertiary">
                    {getBucketLabel(buckets, market.winningBucket)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Bucket pool bars */}
          <div className="space-y-2 pt-2">
            <p className="text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.3)]">
              Bucket Distribution
            </p>
            {Array.from({ length: BUCKET_COUNT }, (_, i) => {
              const bucketTotal = market.bucketTotals[i] ?? 0n
              const pct = market.totalPool > 0n
                ? Number((bucketTotal * 10000n) / market.totalPool) / 100
                : 0
              const isWinner = market.status === 2 && market.winningBucket === i
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className={`font-mono text-[10px] w-24 shrink-0 ${isWinner ? 'text-tertiary' : 'text-[rgba(255,255,255,0.4)]'}`}>
                    {getBucketLabel(buckets, i)}
                  </span>
                  <div className="flex-1 h-1 bg-[rgba(255,255,255,0.05)] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ${isWinner ? 'bg-tertiary' : 'bg-primary'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-[rgba(255,255,255,0.3)] w-8 text-right">
                    {pct.toFixed(0)}%
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!isLoading && !market && (
        <div className="px-6 py-8 text-center">
          <p className="text-[rgba(255,255,255,0.3)] text-sm font-mono">Market not created yet</p>
        </div>
      )}
    </div>
  )
}

export default function MarketStatus() {
  const settledCities = CITY_NAMES // Show all
  const { marketIds, isLoading: isResolvingMarket } = useLatestMarketIds(CITY_NAMES)

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-[rgba(255,255,255,0.06)] pb-6 mb-8">
        <div>
          <h1 className="font-display text-4xl font-bold text-white">Market Status</h1>
          <p className="text-[rgba(255,255,255,0.5)] text-base mt-1">
            Real-time oracle verification and settlement status
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-tertiary animate-pulse-dot shadow-[0_0_8px_#00ff88]" />
          <span className="font-mono text-xs text-tertiary uppercase tracking-wider">Oracle Active</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Markets Grid */}
        <div className="xl:col-span-2 space-y-6">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-tertiary text-xl">verified</span>
            All Markets
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {settledCities.map((cityName) => (
              <CityMarketCard
                key={cityName}
                cityName={cityName}
                marketId={marketIds[cityName]}
                isResolvingMarket={isResolvingMarket}
              />
            ))}
          </div>
        </div>

        {/* Oracle Info Panel */}
        <div className="space-y-5">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">hub</span>
            Oracle Network
          </h2>

          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="p-6 space-y-5">
              {/* Status */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-container/20 border border-primary/30 flex items-center justify-center" style={{ boxShadow: '0 0 15px rgba(0,212,255,0.3)' }}>
                  <span className="material-symbols-outlined text-primary text-xl">radar</span>
                </div>
                <div>
                  <p className="font-semibold text-primary text-sm">Oracle Node Status</p>
                  <p className="text-xs text-tertiary">Operational</p>
                </div>
              </div>

              <div className="space-y-3 border-t border-[rgba(255,255,255,0.06)] pt-4">
                <div className="flex justify-between items-center group cursor-pointer"
                  onClick={() => navigator.clipboard.writeText(CONTRACT_ADDRESS)}>
                  <span className="text-xs text-[rgba(255,255,255,0.4)]">Contract</span>
                  <div className="flex items-center gap-1.5 bg-[rgba(255,255,255,0.05)] px-2 py-1 rounded font-mono text-primary text-xs group-hover:bg-primary/10 transition-colors">
                    {CONTRACT_ADDRESS.slice(0, 8)}...{CONTRACT_ADDRESS.slice(-6)}
                    <span className="material-symbols-outlined text-xs">content_copy</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-[rgba(255,255,255,0.4)]">Data Source</span>
                  <span className="font-mono text-xs text-white">OpenWeather + n8n Oracle</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-[rgba(255,255,255,0.4)]">Network</span>
                  <span className="font-mono text-xs text-white">Arc Testnet #5042002</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-[rgba(255,255,255,0.4)]">Settlement Fee</span>
                  <span className="font-mono text-xs text-white">2%</span>
                </div>
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-[rgba(255,255,255,0.06)]">
                <span className="bg-primary/10 text-primary text-[10px] px-2 py-1 rounded-full font-bold border border-primary/20">
                  Arc Network
                </span>
                <span className="bg-tertiary/10 text-tertiary text-[10px] px-2 py-1 rounded-full font-bold border border-tertiary/20">
                  USDC Settlement
                </span>
                <span className="bg-[rgba(255,255,255,0.05)] text-[rgba(255,255,255,0.5)] text-[10px] px-2 py-1 rounded-full font-bold border border-[rgba(255,255,255,0.1)]">
                  Testnet
                </span>
              </div>

              {/* Description */}
              <div className="p-4 bg-[rgba(255,255,255,0.03)] rounded-xl border border-[rgba(255,255,255,0.06)]">
                <p className="text-xs text-[rgba(255,255,255,0.4)] leading-relaxed">
                  Weather data is sourced from OpenWeather API via n8n automation, submitted on-chain by the oracle wallet. Markets settle at the designated lockTime.
                </p>
              </div>
            </div>
          </div>

          {/* City overview */}
          <div className="glass-card rounded-2xl p-5">
            <h3 className="font-display text-sm font-semibold text-[rgba(255,255,255,0.6)] uppercase tracking-wider mb-4">
              Active Cities
            </h3>
            <div className="space-y-3">
              {CITY_NAMES.map((cityName) => (
                <div key={cityName} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-tertiary animate-pulse-dot" />
                    <span className="font-display text-sm text-white">{cityName}</span>
                  </div>
                  <span className="font-mono text-[10px] text-[rgba(255,255,255,0.3)]">
                    {marketIds[cityName] !== undefined ? `ID #${marketIds[cityName]!.toString()}` : '…'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="mt-12 flex justify-between items-center py-4 border-t border-[rgba(255,255,255,0.06)] text-[10px] font-mono text-[rgba(255,255,255,0.3)]">
        <span className="uppercase tracking-widest">Presage Oracle v1.0</span>
        <div className="flex gap-4">
          <span className="text-tertiary font-bold">Oracle Active</span>
        </div>
      </footer>
    </div>
  )
}
