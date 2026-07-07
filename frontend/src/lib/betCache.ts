export interface CachedBet {
  marketId: string
  bucket: number
  amount: string
  timestamp: number
  txHash: string
}

function cacheKey(address: string) {
  return `arc_bets_${address.toLowerCase()}`
}

export function getCachedBets(address: string): CachedBet[] {
  try {
    const raw = localStorage.getItem(cacheKey(address))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function addCachedBet(address: string, bet: CachedBet) {
  try {
    const existing = getCachedBets(address)
    if (existing.some((b) => b.txHash === bet.txHash)) return
    localStorage.setItem(cacheKey(address), JSON.stringify([...existing, bet]))
  } catch {
    // localStorage unavailable (private mode / quota) — the RPC scan is still the source of truth
  }
}
