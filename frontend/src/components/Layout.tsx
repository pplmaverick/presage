import { type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'

interface LayoutProps {
  children: ReactNode
}

const navItems = [
  { path: '/betting', label: 'Betting', icon: 'show_chart' },
  { path: '/my-bets', label: 'My Bets', icon: 'receipt_long' },
  { path: '/market-status', label: 'Market Status', icon: 'analytics' },
]

function WalletButton() {
  const { address, isConnected } = useAccount()
  const { connect } = useConnect()
  const { disconnect } = useDisconnect()

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.05)] font-mono text-primary text-sm hover:bg-[rgba(255,255,255,0.08)] transition-all"
      >
        <span className="material-symbols-outlined text-[18px]">account_balance_wallet</span>
        {address.slice(0, 6)}...{address.slice(-4)}
      </button>
    )
  }

  return (
    <button
      onClick={() => connect({ connector: injected() })}
      className="btn-primary text-sm"
    >
      Connect Wallet
    </button>
  )
}

export default function Layout({ children }: LayoutProps) {
  const { address, isConnected } = useAccount()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-background">
      {/* Top Nav */}
      <nav className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 bg-[rgba(255,255,255,0.05)] backdrop-blur-xl border-b border-[rgba(255,255,255,0.10)]">
        <div className="flex items-center gap-8">
          <span
            className="font-display text-2xl font-bold text-primary tracking-tighter cursor-pointer"
            onClick={() => navigate('/betting')}
          >
            Arc Weather Market
          </span>
          <div className="hidden md:flex gap-6">
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `font-display text-base transition-colors duration-200 pb-1 ${
                    isActive
                      ? 'text-primary border-b-2 border-primary'
                      : 'text-[rgba(255,255,255,0.5)] hover:text-primary-container'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isConnected && address && (
            <div className="hidden sm:flex flex-col items-end mr-1">
              <span className="font-mono text-xs text-primary">{address.slice(0, 6)}...{address.slice(-4)}</span>
              <span className="text-[10px] uppercase tracking-widest text-tertiary">Arc Testnet</span>
            </div>
          )}
          <WalletButton />
        </div>
      </nav>

      {/* Sidebar (Desktop) */}
      <aside className="hidden lg:flex flex-col h-screen fixed left-0 top-0 pt-24 w-64 bg-[rgba(255,255,255,0.05)] backdrop-blur-md border-r border-[rgba(255,255,255,0.10)] z-40">
        <div className="px-6 mb-8">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-[rgba(255,255,255,0.04)]">
            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-primary to-tertiary opacity-80" />
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-primary">Arc Network</p>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-tertiary animate-pulse-dot" />
                <p className="text-[10px] text-[rgba(255,255,255,0.5)]">Testnet</p>
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
                  isActive
                    ? 'nav-link-active'
                    : 'text-[rgba(255,255,255,0.5)] hover:bg-[rgba(255,255,255,0.06)] hover:text-white'
                }`
              }
            >
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              <span className="font-sans text-sm">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <footer className="p-4 border-t border-[rgba(255,255,255,0.10)] space-y-1">
          <div className="text-[10px] font-mono text-[rgba(255,255,255,0.3)] uppercase tracking-widest px-4 py-2">
            Data Source: OpenWeather + n8n Oracle
          </div>
        </footer>
      </aside>

      {/* Main Content */}
      <main className="lg:ml-64 pt-24 pb-24 lg:pb-8 min-h-screen">
        {children}
      </main>

      {/* Bottom Nav (Mobile) */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center py-3 lg:hidden bg-[rgba(255,255,255,0.05)] backdrop-blur-lg border-t border-[rgba(255,255,255,0.10)] shadow-[0_-4px_20px_rgba(0,212,255,0.1)]">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 transition-all ${
                isActive
                  ? 'text-primary drop-shadow-[0_0_8px_rgba(60,215,255,0.6)]'
                  : 'text-[rgba(255,255,255,0.5)] opacity-60 hover:opacity-100'
              }`
            }
          >
            <span className="material-symbols-outlined text-xl">{item.icon}</span>
            <span className="text-[10px] font-mono uppercase tracking-wider">{item.label.split(' ')[0]}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
