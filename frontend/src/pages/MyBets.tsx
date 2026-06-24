import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useEffect, useState } from 'react'
import { formatUnits, parseGwei } from 'viem'
import { CONTRACT_ADDRESS, getBucketLabel, type CityName } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'
import { useMarket, useClaimed } from '../hooks/useMarket'

interface BetRecord {
  marketId: bigint
  bucket: number
  amount: bigint
  city: CityName
  blockNumber: bigint
}

const CITY_BY_MARKET_ID: Record<string, CityName> = {
  '1': 'Taipei',
  '3': 'Tokyo',
  '4': 'Bangkok',
  '5': 'Seoul',
  '11': 'Taipei',
  '12': 'Tokyo',
  '13': 'Bangkok',
  '14': 'Seoul',
}

function BetRow({ bet }: { bet: BetRecord }) {
  const { market } = useMarket(bet.marketId)
  const { address } = useAccount()
  const { data: isClaimed, refetch: refetchClaimed } = useClaimed(bet.marketId, address)

  const { writeContract, data: claimHash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: claimHash,
  })

  useEffect(() => {
    if (isConfirmed) void refetchClaimed()
  }, [isConfirmed, refetchClaimed])

  if (!market) return null

  const defaultBuckets: readonly bigint[] = [25n, 28n, 31n, 34n]
  const buckets = market.buckets?.length ? market.buckets : defaultBuckets
  const bucketLabel = getBucketLabel(buckets, bet.bucket)
  const amountUsdc = Number(formatUnits(bet.amount, 6)).toFixed(2)

  const status = market.status
  const isWinner = status === 2 && !market.noWinner && market.winningBucket === bet.bucket
  const isRefund = status === 2 && market.noWinner
  const canClaim = (isWinner || isRefund) && !isClaimed

  const statusLabel = status === 0 ? 'Open' : status === 1 ? 'Locked' : 'Settled'
  const statusClass = status === 0 ? 'status-open' : status === 1 ? 'status-locked' : 'status-settled'

  function handleClaim() {
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: WEATHER_MARKET_ABI,
      functionName: 'claimWinnings',
      args: [bet.marketId],
      gas: 200_000n,
      maxPriorityFeePerGas: parseGwei('10'),
      maxFeePerGas: parseGwei('100'),
    })
  }

  return (
    <tr className="border-b border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.03)] transition-colors">
      <td className="px-5 py-4">
        <div className="flex flex-col">
          <span className="font-display text-sm font-semibold text-white">{bet.city}</span>
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">
            Market #{bet.marketId.toString()}
          </span>
        </div>
      </td>
      <td className="px-5 py-4">
        <span className="font-mono text-sm text-primary">{bucketLabel}</span>
      </td>
      <td className="px-5 py-4">
        <span className="font-mono text-sm text-white">{amountUsdc} USDC</span>
      </td>
      <td className="px-5 py-4">
        <span className={statusClass}>{statusLabel}</span>
      </td>
      <td className="px-5 py-4 text-right">
        {canClaim ? (
          <button
            onClick={handleClaim}
            disabled={isPending || isConfirming}
            className="btn-primary text-xs px-4 py-2 disabled:opacity-50 flex items-center gap-1.5"
            style={{ animation: 'claimPulse 2s infinite ease-in-out' }}
          >
            {isPending || isConfirming ? (
              <><span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" /> Claiming...</>
            ) : (
              isRefund ? 'Claim Refund' : 'Claim Winnings'
            )}
          </button>
        ) : isClaimed ? (
          <span className="text-[10px] font-mono text-tertiary">✓ Claimed</span>
        ) : status === 2 && !isWinner && !isRefund ? (
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">No win</span>
        ) : (
          <span className="text-[10px] font-mono text-[rgba(255,255,255,0.3)]">–</span>
        )}
      </td>
    </tr>
  )
}

export default function MyBets() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const [bets, setBets] = useState<BetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    if (!address || !publicClient) return

    async function fetchBets() {
      if (!address || !publicClient) return
      setLoading(true)
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACT_ADDRESS,
          event: {
            type: 'event',
            name: 'BetPlaced',
            inputs: [
              { indexed: true, name: 'marketId', type: 'uint256' },
              { indexed: true, name: 'user', type: 'address' },
              { indexed: false, name: 'bucket', type: 'uint8' },
              { indexed: false, name: 'amount', type: 'uint256' },
            ],
          },
          args: { user: address },
          fromBlock: 0n,
        })

        const records: BetRecord[] = logs.map((log) => {
          const args = log.args as { marketId: bigint; user: string; bucket: number; amount: bigint }
          const cityName = CITY_BY_MARKET_ID[args.marketId.toString()] ?? 'Taipei'
          return {
            marketId: args.marketId,
            bucket: args.bucket,
            amount: args.amount,
            city: cityName as CityName,
            blockNumber: log.blockNumber ?? 0n,
          }
        })

        setBets(records.reverse())
      } catch (e) {
        console.error('Failed to fetch bets:', e)
      } finally {
        setLoading(false)
        setFetched(true)
      }
    }

    void fetchBets()
  }, [address, publicClient])

  if (!isConnected) {
    return (
      <div className="px-6 py-12 max-w-5xl mx-auto text-center">
        <span className="material-symbols-outlined text-5xl text-[rgba(255,255,255,0.15)] block mb-4">
          account_balance_wallet
        </span>
        <h2 className="font-display text-2xl text-white mb-2">Connect Your Wallet</h2>
        <p className="text-[rgba(255,255,255,0.4)] text-sm">
          Connect your wallet to see your betting history
        </p>
      </div>
    )
  }

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="font-display text-4xl font-bold text-white mb-2">My Bets</h1>
        <p className="text-[rgba(255,255,255,0.5)] text-sm">
          Your active and historical positions on Arc Weather Market
        </p>
      </div>

      {/* Active Bets */}
      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">data_usage</span>
            Positions
          </h2>
          {address && (
            <span className="font-mono text-xs text-[rgba(255,255,255,0.3)]">
              {address.slice(0, 8)}...{address.slice(-6)}
            </span>
          )}
        </div>

        {loading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-2 border-primary/40 border-t-primary rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[rgba(255,255,255,0.4)] font-mono text-sm">Scanning chain for your bets...</p>
          </div>
        ) : fetched && bets.length === 0 ? (
          <div className="p-12 text-center">
            <span className="material-symbols-outlined text-4xl text-[rgba(255,255,255,0.15)] block mb-3">
              receipt_long
            </span>
            <p className="text-[rgba(255,255,255,0.4)] text-sm">No bets found for this wallet</p>
            <p className="text-[rgba(255,255,255,0.2)] font-mono text-xs mt-1">
              Go to Betting to place your first bet
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-[rgba(255,255,255,0.03)] border-b border-[rgba(255,255,255,0.06)]">
                  <th className="px-5 py-3 text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Market</th>
                  <th className="px-5 py-3 text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Range</th>
                  <th className="px-5 py-3 text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Stake</th>
                  <th className="px-5 py-3 text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)]">Status</th>
                  <th className="px-5 py-3 text-[10px] font-mono uppercase tracking-widest text-[rgba(255,255,255,0.4)] text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {bets.map((bet, i) => (
                  <BetRow key={`${bet.marketId}-${bet.bucket}-${i}`} bet={bet} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Decorative telem footer */}
      <div className="mt-8 grid grid-cols-2 gap-4 opacity-40">
        <div className="h-20 rounded-xl border border-dashed border-[rgba(255,255,255,0.08)] flex items-center justify-center">
          <span className="font-mono text-[10px] tracking-widest text-[rgba(255,255,255,0.3)]">
            // CHAIN_SYNC_OK
          </span>
        </div>
        <div className="h-20 rounded-xl border border-dashed border-[rgba(255,255,255,0.08)] flex items-center justify-center">
          <span className="font-mono text-[10px] tracking-widest text-[rgba(255,255,255,0.3)]">
            // ORACLE_ACTIVE
          </span>
        </div>
      </div>
    </div>
  )
}
