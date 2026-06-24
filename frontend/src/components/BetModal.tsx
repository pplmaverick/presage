import { useState } from 'react'
import { useAccount, useReadContract, usePublicClient, useWalletClient } from 'wagmi'
import { parseUnits, formatUnits, parseGwei } from 'viem'
import { CONTRACT_ADDRESS, USDC_ADDRESS, getBucketLabel } from '../lib/wagmi'
import { WEATHER_MARKET_ABI, ERC20_ABI } from '../abi'

interface BetModalProps {
  marketId: bigint
  bucketIndex: number
  buckets: readonly bigint[]
  onClose: () => void
  onSuccess: () => void
}

type Step = 'input' | 'approving' | 'betting' | 'done' | 'error'

const GAS_OPTS = {
  gas: 500_000n,
  gasPrice: parseGwei('50'),
} as const

export default function BetModal({ marketId, bucketIndex, buckets, onClose, onSuccess }: BetModalProps) {
  const { address } = useAccount()
  const [amount, setAmount] = useState('')
  const [step, setStep] = useState<Step>('input')
  const [errorMsg, setErrorMsg] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const amountBigInt = amount && !isNaN(Number(amount)) && Number(amount) > 0
    ? parseUnits(amount, 6)
    : 0n

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, CONTRACT_ADDRESS] : undefined,
    query: { enabled: !!address },
  })

  const { data: balance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  const needsApproval = !allowance || allowance < amountBigInt

  async function sendTx(fn: () => Promise<`0x${string}`>) {
    if (!publicClient) throw new Error('No public client')
    const hash = await fn()
    await publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  async function handleSubmit() {
    if (!address || !walletClient || !publicClient || amountBigInt === 0n) return
    setIsLoading(true)
    setErrorMsg('')
    try {
      const nonce = await publicClient.getTransactionCount({ address })

      if (needsApproval) {
        setStep('approving')
        await sendTx(() =>
          walletClient.writeContract({
            address: USDC_ADDRESS,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [CONTRACT_ADDRESS, amountBigInt],
            ...GAS_OPTS,
            nonce,
          })
        )
        await refetchAllowance()
      }

      setStep('betting')
      const betNonce = await publicClient.getTransactionCount({ address })
      await sendTx(() =>
        walletClient.writeContract({
          address: CONTRACT_ADDRESS,
          abi: WEATHER_MARKET_ABI,
          functionName: 'placeBet',
          args: [marketId, bucketIndex, amountBigInt],
          ...GAS_OPTS,
          nonce: betNonce,
        })
      )

      setStep('done')
      onSuccess()
    } catch (err: unknown) {
      setStep('error')
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg.slice(0, 150))
    } finally {
      setIsLoading(false)
    }
  }

  const bucketLabel = getBucketLabel(buckets, bucketIndex)
  const balanceFormatted = balance ? Number(formatUnits(balance, 6)).toFixed(2) : '–'
  const approveOk = !!(allowance && allowance >= amountBigInt && amountBigInt > 0n)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative glass-card rounded-2xl p-8 w-full max-w-md animate-slide-up">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[rgba(255,255,255,0.4)] hover:text-white transition-colors"
        >
          <span className="material-symbols-outlined">close</span>
        </button>

        <h2 className="font-display text-2xl font-bold text-white mb-1">Place Bet</h2>
        <p className="text-[rgba(255,255,255,0.5)] text-sm mb-6">
          Bucket: <span className="text-primary font-mono">{bucketLabel}</span>
        </p>

        {step === 'done' ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-tertiary/20 border border-tertiary/40 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-tertiary text-3xl">check_circle</span>
            </div>
            <p className="font-display text-xl text-white mb-2">Bet Placed!</p>
            <p className="text-[rgba(255,255,255,0.5)] text-sm mb-6">{amount} USDC on {bucketLabel}</p>
            <button onClick={onClose} className="btn-primary w-full">Close</button>
          </div>
        ) : step === 'error' ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-danger-alert/20 border border-danger-alert/40 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-danger-alert text-3xl">error</span>
            </div>
            <p className="font-display text-lg text-white mb-2">Transaction Failed</p>
            <p className="text-[rgba(255,255,255,0.4)] text-xs mb-6 break-all">{errorMsg}</p>
            <button onClick={() => setStep('input')} className="btn-outline w-full">Try Again</button>
          </div>
        ) : (
          <>
            <div className="mb-6">
              <label className="block text-[10px] uppercase tracking-widest text-[rgba(255,255,255,0.4)] mb-2">
                Amount (USDC)
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading}
                  className="w-full bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.10)] rounded-lg px-4 py-3 text-white font-mono text-lg focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-50"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[rgba(255,255,255,0.4)] text-sm font-mono">USDC</span>
              </div>
              <p className="text-[10px] text-[rgba(255,255,255,0.3)] mt-2 font-mono">
                Balance: {balanceFormatted} USDC
              </p>
            </div>

            <div className="flex items-center gap-2 mb-6">
              <div className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${step === 'approving' ? 'text-warning-locked' : approveOk ? 'text-tertiary' : 'text-[rgba(255,255,255,0.3)]'}`}>
                <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[8px] border-current">1</span>
                Approve
              </div>
              <div className="flex-1 h-px bg-[rgba(255,255,255,0.1)]" />
              <div className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider ${step === 'betting' ? 'text-warning-locked' : 'text-[rgba(255,255,255,0.3)]'}`}>
                <span className="w-5 h-5 rounded-full border flex items-center justify-center text-[8px] border-current">2</span>
                Bet
              </div>
            </div>

            <button
              onClick={() => void handleSubmit()}
              disabled={!address || amountBigInt === 0n || isLoading}
              className="w-full btn-primary disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  {step === 'approving' ? 'Approving...' : 'Placing Bet...'}
                </>
              ) : !address ? (
                'Connect Wallet First'
              ) : needsApproval ? (
                `Approve ${amount || '0'} USDC`
              ) : (
                `Confirm Bet – ${amount || '0'} USDC`
              )}
            </button>

            <p className="text-[10px] text-[rgba(255,255,255,0.3)] text-center mt-3 font-mono">
              2% fee · Markets settle at lock time
            </p>
          </>
        )}
      </div>
    </div>
  )
}
