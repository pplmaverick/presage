import type { VercelRequest, VercelResponse } from '@vercel/node'

// Server-side only — never VITE_-prefixed, so it's never bundled into client JS.
//
// There is deliberately no fallback URL here. This used to default to the public Arc
// testnet RPC when ALCHEMY_RPC_URL was unset, which meant a deleted or misspelled
// variable would silently serve testnet data to a mainnet frontend — no error, nothing
// in the console, and no way for a user to tell that the balances and markets they were
// looking at came from the wrong chain. Failing loudly is the only safe behaviour.
const UPSTREAM_RPC_URL = process.env.ALCHEMY_RPC_URL

// Read-only methods only. Nothing that moves funds or touches wallet/node state can reach
// Alchemy through this proxy — write transactions go through the user's injected wallet
// directly (see wagmiConfig's `injected()` connector), never through this transport.
const ALLOWED_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'net_version',
])

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
}

function methodNotAllowedError(req: JsonRpcRequest) {
  return {
    jsonrpc: '2.0' as const,
    id: req.id ?? null,
    error: { code: -32601, message: `Method not allowed: ${req.method ?? 'unknown'}` },
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!UPSTREAM_RPC_URL || UPSTREAM_RPC_URL.trim() === '') {
    return res.status(500).json({
      error:
        'Server misconfigured: the ALCHEMY_RPC_URL environment variable is not set. ' +
        'Set it on this Vercel project (Production and Preview are configured separately) ' +
        'to the upstream Arc RPC endpoint for the chain this deployment targets, then ' +
        'redeploy. There is no fallback: serving a different chain silently would be worse ' +
        'than serving nothing.',
    })
  }

  const body = req.body as JsonRpcRequest | JsonRpcRequest[]
  const requests = Array.isArray(body) ? body : [body]

  const hasDisallowed = requests.some((r) => !r?.method || !ALLOWED_METHODS.has(r.method))
  if (hasDisallowed) {
    // Fail the whole batch, but still return one response per id — a single unmatched id
    // would otherwise leave the caller's request for that id waiting forever.
    const errors = requests.map((r) =>
      r?.method && ALLOWED_METHODS.has(r.method)
        ? { jsonrpc: '2.0' as const, id: r.id ?? null, error: { code: -32000, message: 'Rejected: batch contains a disallowed method' } }
        : methodNotAllowedError(r)
    )
    return res.status(200).json(Array.isArray(body) ? errors : errors[0])
  }

  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    // Most often a malformed ALCHEMY_RPC_URL. Without this the function just crashes with
    // an opaque FUNCTION_INVOCATION_FAILED and nothing points at the variable.
    return res.status(502).json({
      error:
        `Upstream RPC request failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Check that ALCHEMY_RPC_URL is a reachable RPC endpoint.',
    })
  }

  const data = await upstream.json()
  res.status(upstream.status).json(data)
}
