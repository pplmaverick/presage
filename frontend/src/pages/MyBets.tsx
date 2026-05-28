import { useAccount, useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { useConnect } from 'wagmi'
import {
  WEATHER_MARKET_ADDRESS,
  BUCKET_COUNT,
  GAS_OPTS,
  WEATHER_MARKET_ABI,
  STATUS_LABEL,
  STATUS_COLOR,
  getBucketLabel,
  formatUsdc,
  arcscanTx,
} from '../config'
import { useState } from 'react'

type MarketTuple = readonly [string, bigint, bigint, number, bigint, bigint, number, readonly bigint[], boolean]

interface Props {
  marketId: bigint
}

export default function MyBets({ marketId }: Props) {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { writeContractAsync, isPending } = useWriteContract()
  const [claimMsg, setClaimMsg] = useState('')
  const [claimHash, setClaimHash] = useState('')
  const [claimSuccess, setClaimSuccess] = useState(false)

  // ── Read market ─────────────────────────────────────────────────────────────
  const { data: marketRaw } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'getMarket',
    args: [marketId],
    query: { refetchInterval: 30_000 },
  })

  // Destructure tuple
  const marketTuple = marketRaw as MarketTuple | undefined
  const [city, , , status, totalPool, finalTemp, winningBucket, thresholds, noWinner] =
    marketTuple ?? ([] as unknown as MarketTuple)

  // ── Read user bets per bucket ────────────────────────────────────────────────
  const { data: userBetsRaw } = useReadContracts({
    contracts: Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      address: WEATHER_MARKET_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'bets' as const,
      args: [marketId, i, address!] as [bigint, number, `0x${string}`],
    })),
    query: { enabled: isConnected && !!address, refetchInterval: 15_000 },
  })

  // ── Read bucket totals (for prize calculation) ───────────────────────────────
  const { data: bucketTotalsRaw } = useReadContracts({
    contracts: Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      address: WEATHER_MARKET_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'bucketTotals' as const,
      args: [marketId, i] as [bigint, number],
    })),
    query: { enabled: isConnected && !!address },
  })

  // ── Read total bets / claimed status ────────────────────────────────────────
  const { data: userTotal } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'userTotalBets',
    args: [marketId, address!],
    query: { enabled: isConnected && !!address, refetchInterval: 15_000 },
  })

  const { data: hasClaimed, refetch: refetchClaimed } = useReadContract({
    address: WEATHER_MARKET_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'claimed',
    args: [marketId, address!],
    query: { enabled: isConnected && !!address },
  })

  // ── Derived values ───────────────────────────────────────────────────────────
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

  // ── Calculate expected winnings ──────────────────────────────────────────────
  const bucketTotals: bigint[] = Array.from({ length: BUCKET_COUNT }, (_, i) => {
    const r = bucketTotalsRaw?.[i]
    return r?.status === 'success' ? (r.result as bigint) : 0n
  })

  const expectedWinnings = (() => {
    if (!isSettled || !hasBets) return 0n
    if (noWinner) return totalBets
    if (!userWon || winningBucket === undefined) return 0n
    const bucketTotal = bucketTotals[winningBucket]
    if (!bucketTotal || bucketTotal === 0n) return 0n
    const pool = totalPool ?? 0n
    return (pool * 98n / 100n) * userBets[winningBucket] / bucketTotal
  })()

  // ── Claim winnings ───────────────────────────────────────────────────────────
  async function handleClaim() {
    if (!isConnected) return
    setClaimMsg('')
    setClaimHash('')
    setClaimSuccess(false)
    try {
      setClaimMsg('Claiming...')
      const hash = await writeContractAsync({
        address: WEATHER_MARKET_ADDRESS,
        abi: WEATHER_MARKET_ABI,
        functionName: 'claimWinnings',
        args: [marketId],
        ...GAS_OPTS,
      })
      setClaimSuccess(true)
      setClaimHash(hash)
      setClaimMsg('✅ Claimed successfully!')
      await refetchClaimed()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setClaimMsg(`❌ Failed: ${msg.slice(0, 80)}`)
    }
  }

  if (!isConnected) {
    return (
      <div className="bg-slate-900 rounded-2xl p-8 border border-slate-800 text-center mt-4">
        <p className="text-slate-400 mb-4">Connect your wallet to view your bets</p>
        <button
          onClick={() => connect({ connector: injected() })}
          className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-3 rounded-xl transition-colors"
        >
          Connect MetaMask
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6 mt-4">
      {/* Market Status Summary */}
      <div className="flex items-center gap-3">
        <span
          className={`text-xs font-semibold px-3 py-1 rounded-full ${
            STATUS_COLOR[status ?? 0] ?? STATUS_COLOR[0]
          }`}
        >
          {STATUS_LABEL[status ?? 0] ?? '—'}
        </span>
        <span className="text-slate-400 text-sm">
          Market #{marketId.toString()} · {city ?? '—'}
        </span>
      </div>

      {/* Settlement Result */}
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
              <p className="text-amber-400 font-semibold">⚠ No Winner</p>
              <p className="text-slate-400 text-sm mt-1">
                Final Temp: {finalTemp !== undefined ? Number(finalTemp) : '—'}°C · All bets refunded
              </p>
            </div>
          ) : (
            <div>
              <p className="text-yellow-400 font-semibold">🏆 Market Settled</p>
              <p className="text-slate-300 text-sm mt-1">
                Final Temp:&nbsp;
                <span className="text-white font-bold">
                  {finalTemp !== undefined ? Number(finalTemp) : '—'}°C
                </span>
                &nbsp;· Winning Range:&nbsp;
                <span className="text-yellow-400 font-bold">
                  {winningBucket !== undefined
                    ? getBucketLabel(thresholds ?? [], winningBucket)
                    : '—'}
                </span>
              </p>
              {userWon && (
                <p className="text-emerald-400 text-sm mt-2 font-medium">🎉 Congratulations! You won!</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* My Bets List */}
      <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800">
          <h3 className="font-semibold text-white">My Bets</h3>
          {hasBets && (
            <p className="text-slate-400 text-sm mt-0.5">
              Total: {formatUsdc(totalBets)} USDC
            </p>
          )}
        </div>

        {!hasBetsAnywhere ? (
          <div className="px-5 py-8 text-center text-slate-500">No bets placed in this market</div>
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
                        🏆 Winner
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

      {/* Claim Section */}
      {isSettled && hasBetsAnywhere && (
        <div className="bg-slate-900 rounded-2xl p-5 border border-slate-800">
          {hasClaimed || claimSuccess ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-emerald-400">
                <span>✓</span>
                <span className="font-medium">Claimed</span>
              </div>
              {expectedWinnings > 0n && (
                <span className="text-emerald-400 font-mono font-bold">
                  +{formatUsdc(expectedWinnings)} USDC
                </span>
              )}
            </div>
          ) : canClaim ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-slate-300 text-sm">
                  {userCanRefund ? 'No winner — you can reclaim your full deposit' : 'You won! Claim your prize'}
                </p>
                {expectedWinnings > 0n && (
                  <span className="text-yellow-400 font-mono font-bold">
                    +{formatUsdc(expectedWinnings)} USDC
                  </span>
                )}
              </div>
              <button
                onClick={handleClaim}
                disabled={isPending}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-colors"
              >
                {isPending ? 'Processing...' : userCanRefund ? 'Reclaim Deposit' : 'Claim Prize'}
              </button>
              {claimMsg && (
                <p className="text-sm text-slate-400">
                  {claimMsg}
                  {claimHash && (
                    <a
                      href={arcscanTx(claimHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 font-mono text-blue-400 underline hover:text-blue-300 transition-colors"
                    >
                      TX: {claimHash.slice(0, 12)}...
                    </a>
                  )}
                </p>
              )}
            </div>
          ) : (
            <p className="text-slate-500 text-sm">
              {isSettled && !userWon && !noWinner ? 'You did not win this round. No prize to claim.' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
