import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'
import type { Tab } from '../App'
import { shortenAddress, arcscanAddress } from '../config'

interface Props {
  tab: Tab
  setTab: (t: Tab) => void
}

const NAV = [
  { id: 'home' as Tab, label: '首頁' },
  { id: 'myBets' as Tab, label: '我的下注' },
  { id: 'status' as Tab, label: '市場狀態' },
]

export default function Header({ tab, setTab }: Props) {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { disconnect } = useDisconnect()

  return (
    <header className="border-b border-slate-800 mb-6">
      <div className="max-w-3xl mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🌦</span>
            <span className="font-bold text-white">Arc 天氣市場</span>
            <span className="text-xs bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-full ml-1">
              Testnet
            </span>
          </div>

          {isConnected && address ? (
            <div className="flex items-center gap-3">
              <a
                href={arcscanAddress(address)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-400 hover:text-slate-200 text-sm font-mono transition-colors"
              >
                {shortenAddress(address)}
              </a>
              <button
                onClick={() => disconnect()}
                className="text-sm text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg transition-colors"
              >
                斷開
              </button>
            </div>
          ) : (
            <button
              onClick={() => connect({ connector: injected() })}
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              連接錢包
            </button>
          )}
        </div>

        <nav className="flex gap-1 pb-0">
          {NAV.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  )
}
