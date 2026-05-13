import { useState } from 'react'
import { useAccount, useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { useConnect } from 'wagmi'
import {
  WEATHER_MARKET_ADDRESS,
  USDC_ADDRESS,
  MARKET_ID,
  BUCKET_COUNT,
  WEATHER_MARKET_ABI,
  ERC20_ABI,
  STATUS_LABEL,
  STATUS_COLOR,
  getBucketLabel,
  formatUsdc,
} from '../config'

// getMarket 回傳 tuple：[city, targetDate, lockTime, status, totalPool, finalTemp, winningBucket, buckets, noWinner]
type MarketTuple = readonly [string, bigint, bigint, number, bigint, bigint, number, readonly bigint[], boolean]

export default function Home() {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { writeContractAsync, isPending } = useWriteContract()

  const [selectedBucket, setSelectedBucket] = useState<number | null>(null)
  const [betAmount, setBetAmount] = useState('')
  const [txMsg, setTxMsg] = useState('')
  const [isSuccess, setIsSuccess] = useState(false)

  // ── 讀取市場資料 ────────────────────────────────────────────────────────────
  const { data: marketRaw, isLoading: marketLoading } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: [MARKET_ID],
    query: { refetchInterval: 30_000 },
  })

  // ── 讀取每個 bucket 的總下注額 ──────────────────────────────────────────────
  const { data: bucketTotalsRaw } = useReadContracts({
    contracts: Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      address: WEATHER_MARKET_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'bucketTotals' as const,
      args: [MARKET_ID, i] as [bigint, number],
    })),
    query: { refetchInterval: 30_000 },
  })

  // ── USDC 餘額與 allowance ────────────────────────────────────────────────────
  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: isConnected && !!address, refetchInterval: 15_000 },
  })

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, WEATHER_MARKET_ADDRESS],
    query: { enabled: isConnected && !!address, refetchInterval: 10_000 },
  })

  // ── 解構 tuple（viem 對多回傳值解碼為陣列）────────────────────────────────────
  const marketTuple = marketRaw as MarketTuple | undefined
  const [city, targetDate, lockTime, status, totalPool, , winningBucket, thresholds, noWinner] =
    marketTuple ?? ([] as unknown as MarketTuple)
  const marketLoaded = !!marketTuple

  const bucketTotals: bigint[] = Array.from({ length: BUCKET_COUNT }, (_, i) => {
    const r = bucketTotalsRaw?.[i]
    return r?.status === 'success' ? (r.result as bigint) : 0n
  })

  const isOpen = status === 0

  const amountUnits =
    betAmount && !isNaN(parseFloat(betAmount))
      ? BigInt(Math.floor(parseFloat(betAmount) * 1_000_000))
      : 0n
  const needsApproval = amountUnits > 0n && (allowance ?? 0n) < amountUnits

  const maxPool = bucketTotals.reduce((a, b) => (b > a ? b : a), 1n)

  // ── 下注流程 ─────────────────────────────────────────────────────────────────
  async function handleApprove() {
    if (!isConnected || amountUnits === 0n) return
    setTxMsg('')
    setIsSuccess(false)
    try {
      setTxMsg('授權中...')
      await writeContractAsync({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [WEATHER_MARKET_ADDRESS, amountUnits],
      })
      setTxMsg('授權成功！請點「下注」')
      await refetchAllowance()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setTxMsg(`❌ 授權失敗：${msg.slice(0, 80)}`)
    }
  }

  async function handlePlaceBet() {
    if (!isConnected || selectedBucket === null || amountUnits === 0n) return
    setTxMsg('')
    setIsSuccess(false)
    try {
      setTxMsg('下注中...')
      const hash = await writeContractAsync({
        address: WEATHER_MARKET_ADDRESS,
        abi: WEATHER_MARKET_ABI,
        functionName: 'placeBet',
        args: [MARKET_ID, selectedBucket, amountUnits],
      })
      setIsSuccess(true)
      setTxMsg(`✅ 下注成功！TX: ${hash.slice(0, 12)}...`)
      setBetAmount('')
      setSelectedBucket(null)
      await refetchBalance()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setTxMsg(`❌ 下注失敗：${msg.slice(0, 80)}`)
    }
  }

  if (marketLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          載入市場資料中...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 市場資訊卡 */}
      <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">
              🌡 {city ?? '—'} 氣溫預測
            </h2>
            <p className="text-slate-400 text-sm mt-1">
              預測日期：
              {targetDate
                ? new Date(Number(targetDate) * 1000).toLocaleDateString('zh-TW')
                : '—'}
            </p>
          </div>
          <span
            className={`text-xs font-semibold px-3 py-1 rounded-full ${
              STATUS_COLOR[status ?? 0] ?? STATUS_COLOR[0]
            }`}
          >
            {STATUS_LABEL[status ?? 0] ?? '—'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-800 rounded-xl p-3">
            <p className="text-slate-400 text-xs mb-1">總獎池</p>
            <p className="text-white font-bold text-lg">{formatUsdc(totalPool ?? 0n)} USDC</p>
          </div>
          <div className="bg-slate-800 rounded-xl p-3">
            <p className="text-slate-400 text-xs mb-1">鎖盤時間</p>
            <p className="text-white font-bold text-sm">
              {lockTime
                ? new Date(Number(lockTime) * 1000).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei',
                  })
                : '—'}
            </p>
          </div>
        </div>

        {isConnected && usdcBalance !== undefined && (
          <p className="text-slate-500 text-xs mt-3">
            錢包 USDC 餘額：{formatUsdc(usdcBalance)} USDC
          </p>
        )}
      </div>

      {/* 溫度區間 */}
      <div>
        <h3 className="text-sm font-medium text-slate-400 mb-3">選擇溫度區間下注</h3>
        <div className="space-y-2">
          {Array.from({ length: BUCKET_COUNT }, (_, i) => {
            const total = bucketTotals[i]
            const label = getBucketLabel(thresholds ?? [], i)
            const isSelected = selectedBucket === i
            const poolPct = maxPool > 0n ? Number((total * 100n) / maxPool) : 0
            const isWinning = (status ?? 0) === 2 && winningBucket === i

            return (
              <button
                key={i}
                disabled={!isOpen || !isConnected || !marketLoaded}
                onClick={() => setSelectedBucket(isSelected ? null : i)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  isWinning
                    ? 'bg-yellow-500/10 border-yellow-500/40'
                    : isSelected
                    ? 'bg-blue-500/10 border-blue-500/50 ring-1 ring-blue-500/30'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-600'
                } ${
                  !isOpen || !isConnected || !marketLoaded
                    ? 'opacity-70 cursor-default'
                    : 'cursor-pointer'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'border-blue-500 bg-blue-500' : 'border-slate-600'
                      }`}
                    >
                      {isSelected && <span className="w-2 h-2 bg-white rounded-full" />}
                    </span>
                    <span className="font-medium text-white">{label}</span>
                    {isWinning && (
                      <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">
                        🏆 得獎
                      </span>
                    )}
                  </div>
                  <span className="text-slate-300 text-sm font-mono">{formatUsdc(total)} USDC</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isWinning ? 'bg-yellow-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${poolPct}%` }}
                  />
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* 下注表單 */}
      {isConnected ? (
        <div className="bg-slate-900 rounded-2xl p-6 border border-slate-800">
          <h3 className="font-semibold text-white mb-4">
            {isOpen
              ? '下注'
              : status === 1
              ? '市場已鎖盤，不接受下注'
              : '市場已結算'}
          </h3>

          {isOpen && (
            <div className="space-y-4">
              <div>
                <label className="text-sm text-slate-400 mb-1.5 block">
                  已選擇：
                  <span className="text-white ml-1">
                    {selectedBucket !== null
                      ? getBucketLabel(thresholds ?? [], selectedBucket)
                      : '請選擇區間'}
                  </span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="輸入 USDC 金額"
                    value={betAmount}
                    onChange={e => setBetAmount(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                    USDC
                  </span>
                </div>
              </div>

              <div className="flex gap-3">
                {needsApproval ? (
                  <button
                    onClick={handleApprove}
                    disabled={isPending || !betAmount || selectedBucket === null}
                    className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors"
                  >
                    {isPending ? '處理中...' : '① 授權 USDC'}
                  </button>
                ) : (
                  <button
                    onClick={handlePlaceBet}
                    disabled={isPending || !betAmount || selectedBucket === null || amountUnits === 0n}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors"
                  >
                    {isPending ? '處理中...' : '下注'}
                  </button>
                )}
              </div>

              {txMsg && (
                <p
                  className={`text-sm px-3 py-2 rounded-lg ${
                    isSuccess ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {txMsg}
                </p>
              )}
            </div>
          )}

          {!isOpen && status === 2 && noWinner && (
            <p className="text-slate-400 text-sm">
              無人猜中，請前往「我的下注」頁面領回押金。
            </p>
          )}
        </div>
      ) : (
        <div className="bg-slate-900 rounded-2xl p-8 border border-slate-800 text-center">
          <p className="text-slate-400 mb-4">連接錢包才能下注</p>
          <button
            onClick={() => connect({ connector: injected() })}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3 rounded-xl transition-colors"
          >
            連接 MetaMask
          </button>
        </div>
      )}
    </div>
  )
}
