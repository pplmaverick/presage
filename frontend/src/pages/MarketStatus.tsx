import { useEffect, useState } from 'react'
import { useReadContract } from 'wagmi'
import {
  WEATHER_MARKET_ADDRESS,
  ADMIN_ORACLE_ADDRESS,
  WEATHER_MARKET_ABI,
  STATUS_LABEL,
  STATUS_COLOR,
  getBucketLabel,
  formatUsdc,
  shortenAddress,
} from '../config'

type MarketTuple = readonly [string, bigint, bigint, number, bigint, bigint, number, readonly bigint[], boolean]

interface Props {
  marketId: bigint
}

export default function MarketStatus({ marketId }: Props) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  const { data: marketRaw, isLoading } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: [marketId],
    query: { refetchInterval: 30_000 },
  })

  // 解構 tuple
  const marketTuple = marketRaw as MarketTuple | undefined
  const [city, targetDate, lockTime, status, totalPool, finalTemp, winningBucket, thresholds, noWinner] =
    marketTuple ?? ([] as unknown as MarketTuple)

  function formatCountdown(sec: bigint): string {
    const diff = Number(sec) - now
    if (diff <= 0) return '已過'
    const d = Math.floor(diff / 86400)
    const h = Math.floor((diff % 86400) / 3600)
    const m = Math.floor((diff % 3600) / 60)
    const s = diff % 60
    if (d > 0) return `${d}d ${h}h ${m}m`
    if (h > 0) return `${h}h ${m}m ${s}s`
    return `${m}m ${s}s`
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          載入中...
        </div>
      </div>
    )
  }

  const statusIdx = status ?? 0

  return (
    <div className="space-y-4 mt-4">
      {/* 狀態標題 */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white">市場狀態</h2>
          <span
            className={`text-sm font-semibold px-3 py-1.5 rounded-full ${
              STATUS_COLOR[statusIdx] ?? STATUS_COLOR[0]
            }`}
          >
            {STATUS_LABEL[statusIdx] ?? '—'}
          </span>
        </div>

        <div className="space-y-3">
          <Row label="Market ID" value={`#${marketId.toString()}`} />
          <Row label="城市" value={city ?? '—'} />
          <Row
            label="預測日期"
            value={
              targetDate
                ? new Date(Number(targetDate) * 1000).toLocaleDateString('zh-TW', {
                    timeZone: 'Asia/Taipei',
                  })
                : '—'
            }
          />
          <Row
            label="鎖盤時間"
            value={
              lockTime
                ? new Date(Number(lockTime) * 1000).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei',
                  })
                : '—'
            }
          />
          {statusIdx === 0 && lockTime !== undefined && lockTime > 0n && (
            <Row label="距離鎖盤" value={formatCountdown(lockTime)} highlight />
          )}
          <Row label="總獎池" value={`${formatUsdc(totalPool ?? 0n)} USDC`} />
        </div>
      </div>

      {/* 結算資訊 */}
      {statusIdx === 2 && marketTuple && (
        <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
          <h3 className="font-semibold text-white mb-4">結算結果</h3>
          <div className="space-y-3">
            <Row
              label="最終氣溫"
              value={finalTemp !== undefined ? `${Number(finalTemp)}°C` : '—'}
              highlight
            />
            {noWinner ? (
              <Row label="得獎區間" value="無人猜中（全額退回）" />
            ) : (
              <Row
                label="得獎區間"
                value={
                  winningBucket !== undefined
                    ? getBucketLabel(thresholds ?? [], winningBucket)
                    : '—'
                }
                highlight
              />
            )}
          </div>
        </div>
      )}

      {/* 溫度區間說明 */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="font-semibold text-white mb-4">溫度區間</h3>
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                statusIdx === 2 && !noWinner && winningBucket === i
                  ? 'bg-yellow-500/10 border border-yellow-500/30'
                  : 'bg-slate-800'
              }`}
            >
              <span className="text-slate-300 text-sm">
                Bucket {i} — {getBucketLabel(thresholds ?? [], i)}
              </span>
              {statusIdx === 2 && !noWinner && winningBucket === i && (
                <span className="text-yellow-400 text-xs">🏆</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Oracle 資訊 */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <h3 className="font-semibold text-white mb-4">Oracle 資訊</h3>
        <div className="space-y-3">
          <Row label="合約類型" value="AdminOracle（人工提交）" />
          <div className="flex items-center justify-between">
            <span className="text-slate-400 text-sm">Oracle 地址</span>
            <a
              href={`https://testnet.arcscan.app/address/${ADMIN_ORACLE_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-sm font-mono transition-colors"
            >
              {shortenAddress(ADMIN_ORACLE_ADDRESS)}
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400 text-sm">WeatherMarket 合約</span>
            <a
              href={`https://testnet.arcscan.app/address/${WEATHER_MARKET_ADDRESS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 text-sm font-mono transition-colors"
            >
              {shortenAddress(WEATHER_MARKET_ADDRESS)}
            </a>
          </div>
          <Row label="資料來源" value="OpenWeather + n8n Oracle" />
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className={`text-sm font-medium ${highlight ? 'text-white' : 'text-slate-300'}`}>
        {value}
      </span>
    </div>
  )
}
