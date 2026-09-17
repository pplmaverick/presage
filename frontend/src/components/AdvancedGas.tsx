import { useState } from 'react'
import { parseGwei } from 'viem'

export interface GasOverride {
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

/**
 * 可收合的進階 gas 設定。
 * 預設完全不傳任何 gas 參數 —— 交由連接的錢包用它自己的 EIP-1559 建議值，
 * 這在一般情況下是最準的。只有在錢包估太低卡住時才需要手動覆寫。
 * scripts/lib/ops.ts 那套 eth_feeHistory 動態計算刻意沒有搬過來。
 */
export function useGasOverride() {
  const [maxFee, setMaxFee] = useState('')
  const [priority, setPriority] = useState('')

  function build(): GasOverride {
    const o: GasOverride = {}
    try {
      if (maxFee.trim()) o.maxFeePerGas = parseGwei(maxFee.trim())
      if (priority.trim()) o.maxPriorityFeePerGas = parseGwei(priority.trim())
    } catch {
      // 輸入不是合法數字就當作沒設定
      return {}
    }
    return o
  }

  return { maxFee, setMaxFee, priority, setPriority, build }
}

interface Props {
  state: ReturnType<typeof useGasOverride>
}

export default function AdvancedGas({ state }: Props) {
  const [open, setOpen] = useState(false)
  const { maxFee, setMaxFee, priority, setPriority } = state
  const active = maxFee.trim() !== '' || priority.trim() !== ''

  return (
    <div className="border-t border-[rgba(255,255,255,0.08)] pt-3 mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)] hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-[14px]">
          {open ? 'expand_less' : 'expand_more'}
        </span>
        進階 gas 設定
        {active && !open && (
          <span className="text-tertiary normal-case">（已覆寫）</span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] text-[rgba(255,255,255,0.35)] leading-relaxed">
            留空 = 使用錢包的 EIP-1559 建議值（建議做法）。只有交易長時間卡在
            pending 時才需要手動調高。單位 gwei。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
                maxFeePerGas
              </span>
              <input
                value={maxFee}
                onChange={(e) => setMaxFee(e.target.value)}
                placeholder="auto"
                inputMode="decimal"
                className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 font-mono text-sm text-white placeholder:text-[rgba(255,255,255,0.25)] focus:outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[rgba(255,255,255,0.4)]">
                maxPriorityFeePerGas
              </span>
              <input
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                placeholder="auto"
                inputMode="decimal"
                className="bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] rounded-lg px-3 py-2 font-mono text-sm text-white placeholder:text-[rgba(255,255,255,0.25)] focus:outline-none focus:border-primary"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
