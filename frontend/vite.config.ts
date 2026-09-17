import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 本地開發用的 /api 實作。
//
// 正式環境 /api/rpc 與 /api/weather/[city] 是 Vercel Functions（frontend/api/），
// 但 `vite dev` 不會執行它們。原本這裡的 proxy 把整個 /api 轉去
// http://46.62.246.244:3001 —— 那是另一個專案（Tempo）的 oracle server，
// 不是 Arc RPC，所以自從 /api/rpc 這層代理加進來之後，本地開發的 RPC 一直是壞的。
//
// 這個 plugin 只在 dev server 生效，build 產物完全不受影響。
function devApiPlugin(env: Record<string, string>): Plugin {
  const RPC_BY_NETWORK: Record<string, string> = {
    testnet: 'https://rpc.testnet.arc.io',
    mainnet: 'https://rpc.mainnet.arc.io',
  }

  // 與 frontend/api/rpc.ts 的白名單保持一致
  const ALLOWED_METHODS = new Set([
    'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_estimateGas',
    'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
    'eth_getBalance', 'eth_getCode', 'eth_getStorageAt',
    'eth_getTransactionCount', 'eth_getTransactionByHash',
    'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getBlockByHash',
    'eth_getLogs', 'net_version',
  ])

  const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
    taipei: { lat: 25.033, lon: 121.5654 },
    tokyo: { lat: 35.6762, lon: 139.6503 },
    bangkok: { lat: 13.7563, lon: 100.5018 },
    seoul: { lat: 37.5665, lon: 126.978 },
  }

  return {
    name: 'dev-api',
    apply: 'serve',
    configureServer(server) {
      // 一定要用 loadEnv 讀出來的 env —— vite.config 裡的 process.env
      // 不會自動含有 .env / .env.<mode>.local 的內容，直接讀會拿到 undefined，
      // 結果就是 client 連 testnet、dev proxy 卻轉去 mainnet。
      const network = (env.VITE_NETWORK ?? 'mainnet').trim().toLowerCase()
      const upstream =
        env.DEV_RPC_URL ?? RPC_BY_NETWORK[network] ?? RPC_BY_NETWORK.mainnet
      server.config.logger.info(`[dev-api] /api/rpc → ${upstream} (VITE_NETWORK=${network})`)

      server.middlewares.use('/api/rpc', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end(JSON.stringify({ error: 'Method not allowed' }))
        }
        const chunks: Uint8Array[] = []
        req.on('data', (c) => chunks.push(c as Uint8Array))
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const reqs = Array.isArray(body) ? body : [body]
            const bad = reqs.some((r) => !r?.method || !ALLOWED_METHODS.has(r.method))
            if (bad) {
              res.setHeader('content-type', 'application/json')
              const errs = reqs.map((r) => ({
                jsonrpc: '2.0', id: r?.id ?? null,
                error: { code: -32601, message: `Method not allowed: ${r?.method ?? 'unknown'}` },
              }))
              return res.end(JSON.stringify(Array.isArray(body) ? errs : errs[0]))
            }
            const up = await fetch(upstream, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            const text = await up.text()
            res.statusCode = up.status
            res.setHeader('content-type', 'application/json')
            res.end(text)
          } catch (err) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(err) }))
          }
        })
      })

      server.middlewares.use('/api/weather', async (req, res) => {
        const slug = (req.url ?? '').replace(/^\//, '').split('?')[0].toLowerCase()
        const coords = CITY_COORDS[slug]
        res.setHeader('content-type', 'application/json')
        if (!coords) {
          res.statusCode = 404
          return res.end(JSON.stringify({ error: 'Unknown city' }))
        }
        const apiKey = env.OPENWEATHER_API_KEY ?? env.VITE_OPENWEATHER_API_KEY
        if (!apiKey) {
          res.statusCode = 500
          return res.end(JSON.stringify({ error: 'OPENWEATHER_API_KEY 未設定（dev）' }))
        }
        try {
          const url = `https://api.openweathermap.org/data/2.5/weather?lat=${coords.lat}&lon=${coords.lon}&appid=${apiKey}&units=metric`
          const up = await fetch(url)
          if (!up.ok) {
            res.statusCode = 502
            return res.end(JSON.stringify({ error: `Upstream ${up.status}` }))
          }
          const d = await up.json() as any
          res.end(JSON.stringify({
            temp: d.main.temp,
            humidity: d.main.humidity,
            windspeed: d.wind?.speed ?? null,
            description: d.weather?.[0]?.description ?? '',
            city: slug,
          }))
        } catch (err) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: String(err) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), devApiPlugin(env)],
  }
})
