export interface CachedBet {
  marketId: string
  bucket: number
  amount: string
  timestamp: number
  txHash: string
}

// Bounds localStorage growth — keeps the most recent bets by timestamp, drops the rest.
const MAX_CACHED_BETS = 500

function cacheKey(address: string) {
  return `arc_bets_${address.toLowerCase()}`
}

function capBets(bets: CachedBet[]): CachedBet[] {
  if (bets.length <= MAX_CACHED_BETS) return bets
  return [...bets].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_CACHED_BETS)
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
    localStorage.setItem(cacheKey(address), JSON.stringify(capBets([...existing, bet])))
  } catch {
    // localStorage unavailable (private mode / quota) — the RPC scan is still the source of truth
  }
}

// Replaces the full cache with a freshly-scanned/merged bet list (used after a chain scan completes),
// so future page loads don't need to rescan bets that are already confirmed on-chain.
export function setCachedBets(address: string, bets: CachedBet[]) {
  try {
    localStorage.setItem(cacheKey(address), JSON.stringify(capBets(bets)))
  } catch {
    // localStorage unavailable (private mode / quota) — the RPC scan is still the source of truth
  }
}
