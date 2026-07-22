import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { CONTRACT_ADDRESS, DEPLOY_BLOCK, getBucketLabel } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'
import { useMarket, useClaimed } from '../hooks/useMarket'
import { getCachedBets, setCachedBets, type CachedBet } from '../lib/betCache'

interface BetRecord {
  marketId: bigint
  bucket: number
  amount: bigint
  blockNumber: bigint
  txHash: string
}

function cachedBetToRecord(bet: CachedBet): BetRecord {
  return {
    marketId: BigInt(bet.marketId),
    bucket: bet.bucket,
    amount: BigInt(bet.amount),
    blockNumber: 0n,
    txHash: bet.txHash,
  }
}

function recordToCachedBet(record: BetRecord): CachedBet {
  return {
    marketId: record.marketId.toString(),
    bucket: record.bucket,
    amount: record.amount.toString(),
    timestamp: Date.now(),
    txHash: record.txHash,
  }
}

function mergeBetsByTxHash(chainRecords: BetRecord[], cachedRecords: BetRecord[]): BetRecord[] {
  const byTxHash = new Map<string, BetRecord>()
  for (const r of cachedRecords) byTxHash.set(r.txHash, r)
  for (const r of chainRecords) byTxHash.set(r.txHash, r) // chain data wins on conflict
  return Array.from(byTxHash.values()).sort((a, b) => {
    if (a.blockNumber === 0n && b.blockNumber !== 0n) return -1
    if (b.blockNumber === 0n && a.blockNumber !== 0n) return 1
    return a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? 1 : -1
  })
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
    })
  }

  return (
    <tr className="border-b border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.03)] transition-colors">
      <td className="px-5 py-4">
        <div className="flex flex-col">
          <span className="font-display text-sm font-semibold text-white">{market.city}</span>
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

const LOG_BATCH_SIZE = 9_000n
const MAX_CONCURRENT_REQUESTS = 20

function buildBlockRanges(fromBlock: bigint, toBlock: bigint, step: bigint) {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = []
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = start + step - 1n > toBlock ? toBlock : start + step - 1n
    ranges.push({ fromBlock: start, toBlock: end })
  }
  return ranges
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onItemDone: () => void
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++
      results[current] = await fn(items[current])
      onItemDone()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export default function MyBets() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const [bets, setBets] = useState<BetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [fetched, setFetched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cachedRecordsRef = useRef<BetRecord[]>([])

  // Load cached bets synchronously so recent bets show up instantly, before the chain scan finishes.
  useEffect(() => {
    if (!address) {
      cachedRecordsRef.current = []
      setBets([])
      return
    }
    const cached = getCachedBets(address).map(cachedBetToRecord)
    cachedRecordsRef.current = cached
    setBets(cached)
  }, [address])

  useEffect(() => {
    if (!address || !publicClient) return

    async function fetchBets() {
      if (!address || !publicClient) return
      setLoading(true)
      setError(null)
      setProgress(0)
      try {
        const latestBlock = await publicClient.getBlockNumber()
        const ranges = buildBlockRanges(DEPLOY_BLOCK, latestBlock, LOG_BATCH_SIZE)
        let completed = 0

        const batches = await mapWithConcurrency(
          ranges,
          MAX_CONCURRENT_REQUESTS,
          ({ fromBlock, toBlock }) =>
            publicClient.getLogs({
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
              fromBlock,
              toBlock,
            }),
          () => {
            completed++
            setProgress(Math.round((completed / ranges.length) * 100))
          }
        )
        const logs = batches.flat()

        const records: BetRecord[] = logs.map((log) => {
          const args = log.args as { marketId: bigint; user: string; bucket: number; amount: bigint }
          return {
            marketId: args.marketId,
            bucket: args.bucket,
            amount: args.amount,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash ?? '',
          }
        })

        const merged = mergeBetsByTxHash(records, cachedRecordsRef.current)
        cachedRecordsRef.current = merged
        setBets(merged)
        setCachedBets(address, merged.map(recordToCachedBet))
      } catch (e) {
        console.error('Failed to fetch bets:', e)
        setError(e instanceof Error ? e.message : 'Failed to load betting history')
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
          Your active and historical positions on Presage
        </p>
      </div>

      {/* Active Bets */}
      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">data_usage</span>
            Positions
          </h2>
          <div className="flex items-center gap-3">
            {loading && bets.length > 0 && (
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-[rgba(255,255,255,0.35)]">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Syncing chain history...
              </span>
            )}
            {address && (
              <span className="font-mono text-xs text-[rgba(255,255,255,0.3)]">
                {address.slice(0, 8)}...{address.slice(-6)}
              </span>
            )}
          </div>
        </div>

        {bets.length === 0 && loading ? (
          <div className="p-12 text-center">
            <div className="w-8 h-8 border-2 border-primary/40 border-t-primary rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[rgba(255,255,255,0.4)] font-mono text-sm">Scanning blocks... {progress}%</p>
            <div className="w-48 h-1 bg-[rgba(255,255,255,0.08)] rounded-full mx-auto mt-3 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : bets.length === 0 && error ? (
          <div className="p-12 text-center">
            <span className="material-symbols-outlined text-4xl text-red-400/60 block mb-3">
              error
            </span>
            <p className="text-red-400/80 text-sm">Failed to load betting history</p>
            <p className="text-[rgba(255,255,255,0.3)] font-mono text-xs mt-1">{error}</p>
          </div>
        ) : fetched && !loading && bets.length === 0 ? (
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
