const REQUIRED_VARS = [
  {
    name: 'VITE_CONTRACT_MAINNET',
    scope: 'client (bundled)',
    what: 'Arc 主網 WeatherMarket 合約位址',
  },
  {
    name: 'VITE_DEPLOY_BLOCK_MAINNET',
    scope: 'client (bundled)',
    what: 'WeatherMarket 的部署區塊高度，MyBets 的 log 掃描起點',
  },
  {
    name: 'ALCHEMY_RPC_URL',
    scope: 'server only',
    what: '/api/rpc 代理的上游 RPC（Arc 主網）',
  },
  {
    name: 'OPENWEATHER_API_KEY',
    scope: 'server only',
    what: '/api/weather/[city] 用的 OpenWeather key',
  },
]

const OPTIONAL_VARS = [
  {
    name: 'VITE_ADMIN_ORACLE_MAINNET',
    scope: 'client (bundled)',
    what: 'AdminOracle 位址，只有 /admin 的提交結果需要',
  },
]

export default function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card rounded-2xl max-w-2xl w-full p-8">
        <div className="flex items-center gap-3 mb-4">
          <span
            aria-hidden
            className="w-10 h-10 rounded-full bg-red-500/15 border border-red-500/40 flex items-center justify-center text-red-400 text-xl"
          >
            !
          </span>
          <h1 className="font-display text-2xl text-white">部署設定錯誤</h1>
        </div>

        <p className="text-sm text-white/70 mb-5 leading-relaxed">
          這個版本缺少必要的環境變數，因此無法確定要連到哪一份合約。
          為了避免把交易送到錯誤的合約，前端已停止載入。
        </p>

        <pre className="text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-6 whitespace-pre-wrap break-words text-red-200">
          {message}
        </pre>

        <h2 className="font-display text-sm uppercase tracking-wider text-white/50 mb-3">
          需要設定的環境變數
        </h2>
        <div className="space-y-2 mb-6">
          {REQUIRED_VARS.map((v) => (
            <div
              key={v.name}
              className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 text-sm border-b border-white/5 pb-2"
            >
              <code className="text-cyan-300 font-mono shrink-0">{v.name}</code>
              <span className="text-white/35 text-xs shrink-0">{v.scope}</span>
              <span className="text-white/60">{v.what}</span>
            </div>
          ))}
        </div>

        <h2 className="font-display text-sm uppercase tracking-wider text-white/50 mb-3">
          選填
        </h2>
        <div className="space-y-2 mb-6">
          {OPTIONAL_VARS.map((v) => (
            <div
              key={v.name}
              className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 text-sm border-b border-white/5 pb-2"
            >
              <code className="text-white/50 font-mono shrink-0">{v.name}</code>
              <span className="text-white/30 text-xs shrink-0">{v.scope}</span>
              <span className="text-white/50">{v.what}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-white/40 leading-relaxed">
          在 Vercel 專案設定 → Environment Variables 補齊後，需要重新 deploy
          才會生效（<code className="font-mono">VITE_</code> 開頭的變數是在 build
          期打進 bundle 的，改完不重 build 不會變）。Production 與 Preview
          兩個環境各自獨立，兩邊都要設。
        </p>
      </div>
    </div>
  )
}
