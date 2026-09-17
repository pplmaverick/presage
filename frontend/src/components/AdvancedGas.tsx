import { useState } from 'react'
import { parseGwei } from 'viem'

export interface GasOverride {
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

/**
 * Collapsible advanced gas settings.
 * By default no gas parameters are passed at all — the connected wallet uses its own
 * EIP-1559 suggestion, which is usually the most accurate. A manual override is only
 * needed when the wallet underestimates and the transaction stalls.
 * The eth_feeHistory calculation from scripts/lib/ops.ts is deliberately not ported here.
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
      // Treat unparseable input as if nothing was set
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
        Advanced gas settings
        {active && !open && (
          <span className="text-tertiary normal-case">(overridden)</span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] text-[rgba(255,255,255,0.35)] leading-relaxed">
            Leave blank to use the wallet's EIP-1559 suggestion (recommended). Raise
            these only if a transaction stays pending for a long time. Units: gwei.
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
