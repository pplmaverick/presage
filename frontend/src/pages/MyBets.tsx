import { useAccount, useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { useConnect } from 'wagmi'
import {
  WEATHER_MARKET_ADDRESS,
  MARKET_ID,
  BUCKET_COUNT,
  WEATHER_MARKET_ABI,
  STATUS_LABEL,
  STATUS_COLOR,
  getBucketLabel,
  formatUsdc,
} from '../config'
import { useState } from 'react'

type MarketTuple = readonly [string, bigint, bigint, number, bigint, bigint, number, readonly bigint[], boolean]

export default function MyBets() {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { writeContractAsync, isPending } = useWriteContract()
  const [claimMsg, setClaimMsg] = useState('')
  const [claimSuccess, setClaimSuccess] = useState(false)

  // ── 讀取市場 ────────────────────────────────────────────────────────────────
  const { data: marketRaw } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: [MARKET_ID],
    query: { refetchInterval: 30_000 },
  })

  // 解構 tuple
  const marketTuple = marketRaw as MarketTuple | undefined
  const [city, , , status, , finalTemp, winningBucket, thresholds, noWinner] =
    marketTuple ?? ([] as unknown as MarketTuple)

  // ── 讀取用戶各 bucket 下注 ──────────────────────────────────────────────────
  const { data: userBetsRaw } = useReadContracts({
    contracts: Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      address: WEATHER_MARKET_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'bets' as const,
      args: [MARKET_ID, i, address!] as [bigint, number, `0x${string}`],
    })),
    query: { enabled: isConnected && !!address, refetchInterval: 15_000 },
  })

  // ── 讀取總下注 / 已領取 ─────────────────────────────────────────────────────
  const { data: userTotal } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'userTotalBets',
    args: [MARKET_ID, address!],
    query: { enabled: isConnected && !!address, refetchInterval: 15_000 },
  })

  const { data: hasClaimed, refetch: refetchClaimed } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'claimed',
    args: [MARKET_ID, address!],
    query: { enabled: isConnected && !!address },
  })

  // ── 衍生值 ──────────────────────────────────────────────────────────────────
  const userBets: bigint[] = Array.from({ length: BUCKET_COUNT }, (_, i) => {
    const r = userBetsRaw?.[i]
    return r?.status === 'success' ? (r.result as bigint) : 0n
  })

  const isSettled = (status ?? 0) === 2
  const totalBets = (userTotal as bigint | undefined) ?? 0n
  const hasBets = totalBets > 0n
  const hasBetsAnywhere = userBets.some(b => b > 0n)

  const userWon = isSettled && !noWinner && winningBucket !== undefined && userBets[winningBucket] > 0n
  const userCanRefund = isSettled && noWinner && hasBets
  const canClaim = (userWon || userCanRefund) && !hasClaimed && !claimSuccess

  // ── 領獎 ─────────────────────────────────────────────────────────────────────
  async function handleClaim() {
    if (!isConnected) return
    setClaimMsg('')
    setClaimSuccess(false)
    try {
      setClaimMsg('領獎中...')
      const hash = await writeContractAsync({
        address: WEATHER_MARKET_ADDRESS,
        abi: WEATHER_MARKET_ABI,
        functionName: 'claimWinnings',
        args: [MARKET_ID],
      })
      setClaimSuccess(true)
      setClaimMsg(`✅ 領獎成功！TX: ${hash.slice(0, 12)}...`)
      await refetchClaimed()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setClaimMsg(`❌ 失敗：${msg.slice(0, 80)}`)
    }
  }

  if (!isConnected) {
    return (
      <div className="bg-slate-900 rounded-2xl p-8 border border-slate-800 text-center mt-4">
        <p className="text-slate-400 mb-4">連接錢包查看你的下注記錄</p>
        <button
          onClick={() => connect({ connector: injected() })}
          className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3 rounded-xl transition-colors"
        >
          連接 MetaMask
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 mt-4">
      {/* 市場狀態摘要 */}
      <div className="flex items-center gap-3">
        <span
          className={`text-xs font-semibold px-3 py-1 rounded-full ${
            STATUS_COLOR[status ?? 0] ?? STATUS_COLOR[0]
          }`}
        >
          {STATUS_LABEL[status ?? 0] ?? '—'}
        </span>
        <span className="text-slate-400 text-sm">
          市場 #{MARKET_ID.toString()} · {city ?? '—'}
        </span>
      </div>

      {/* 結算結果（已結算） */}
      {isSettled && marketTuple && (
        <div
          className={`rounded-2xl p-5 border ${
            noWinner
              ? 'bg-slate-800/50 border-slate-700'
              : 'bg-yellow-500/5 border-yellow-500/30'
          }`}
        >
          {noWinner ? (
            <div>
              <p className="text-amber-400 font-semibold">⚠ 無人猜中</p>
              <p className="text-slate-400 text-sm mt-1">
                最終氣溫：{finalTemp !== undefined ? Number(finalTemp) : '—'}°C · 所有押注全額退回
              </p>
            </div>
          ) : (
            <div>
              <p className="text-yellow-400 font-semibold">🏆 市場已結算</p>
              <p className="text-slate-300 text-sm mt-1">
                最終氣溫：
                <span className="text-white font-bold">
                  {finalTemp !== undefined ? Number(finalTemp) : '—'}°C
                </span>
                &nbsp;· 得獎區間：
                <span className="text-yellow-400 font-bold">
                  {winningBucket !== undefined
                    ? getBucketLabel(thresholds ?? [], winningBucket)
                    : '—'}
                </span>
              </p>
              {userWon && (
                <p className="text-emerald-400 text-sm mt-2 font-medium">🎉 恭喜！你猜中了！</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 我的下注清單 */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 className="font-semibold text-white">我的下注</h3>
          {hasBets && (
            <p className="text-slate-400 text-sm mt-0.5">
              合計：{formatUsdc(totalBets)} USDC
            </p>
          )}
        </div>

        {!hasBetsAnywhere ? (
          <div className="px-5 py-8 text-center text-slate-500">尚未在此市場下注</div>
        ) : (
          <div className="divide-y divide-slate-800">
            {userBets.map((amount, i) => {
              if (amount === 0n) return null
              const label = getBucketLabel(thresholds ?? [], i)
              const isWinning = isSettled && !noWinner && i === winningBucket

              return (
                <div
                  key={i}
                  className={`flex items-center justify-between px-5 py-4 ${
                    isWinning ? 'bg-yellow-500/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium">{label}</span>
                    {isWinning && (
                      <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">
                        🏆 得獎
                      </span>
                    )}
                  </div>
                  <span className="text-slate-300 font-mono">{formatUsdc(amount)} USDC</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 領獎區塊 */}
      {isSettled && hasBetsAnywhere && (
        <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800">
          {hasClaimed || claimSuccess ? (
            <div className="flex items-center gap-2 text-emerald-400">
              <span>✓</span>
              <span className="font-medium">已領取</span>
            </div>
          ) : canClaim ? (
            <div className="space-y-3">
              <p className="text-slate-300 text-sm">
                {userCanRefund
                  ? '無人猜中，可領回全額押金'
                  : userWon
                  ? '你猜中了！請領取獎金'
                  : ''}
              </p>
              <button
                onClick={handleClaim}
                disabled={isPending}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-colors"
              >
                {isPending ? '處理中...' : userCanRefund ? '領回押金' : '領取獎金'}
              </button>
              {claimMsg && <p className="text-sm text-slate-400">{claimMsg}</p>}
            </div>
          ) : (
            <p className="text-slate-500 text-sm">
              {isSettled && !userWon && !noWinner ? '此次未猜中，沒有獎金可領。' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
