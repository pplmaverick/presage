const REQUIRED_VARS = [
  {
    name: 'VITE_CONTRACT_MAINNET',
    scope: 'client (bundled)',
    what: 'WeatherMarket contract address on Arc mainnet',
  },
  {
    name: 'VITE_DEPLOY_BLOCK_MAINNET',
    scope: 'client (bundled)',
    what: 'WeatherMarket deployment block — where MyBets starts its log scan',
  },
  {
    name: 'ALCHEMY_RPC_URL',
    scope: 'server only',
    what: 'Upstream RPC for the /api/rpc proxy (Arc mainnet)',
  },
  {
    name: 'OPENWEATHER_API_KEY',
    scope: 'server only',
    what: 'OpenWeather key used by /api/weather/[city]',
  },
]

const OPTIONAL_VARS = [
  {
    name: 'VITE_ADMIN_ORACLE_MAINNET',
    scope: 'client (bundled)',
    what: 'AdminOracle address — only needed by submit-result on /admin',
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
          <h1 className="font-display text-2xl text-white">Deployment configuration error</h1>
        </div>

        <p className="text-sm text-white/70 mb-5 leading-relaxed">
          This build is missing required environment variables, so it cannot determine
          which contract to connect to. To avoid sending transactions to the wrong
          contract, the frontend has stopped loading.
        </p>

        <pre className="text-sm bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-6 whitespace-pre-wrap break-words text-red-200">
          {message}
        </pre>

        <h2 className="font-display text-sm uppercase tracking-wider text-white/50 mb-3">
          Required environment variables
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
          Optional
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
          Fill these in under Vercel project settings → Environment Variables, then
          redeploy — variables prefixed with <code className="font-mono">VITE_</code> are
          baked into the bundle at build time, so changing them without rebuilding has no
          effect. Production and Preview are separate environments; set both.
        </p>
      </div>
    </div>
  )
}
