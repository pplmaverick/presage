import { useState } from 'react'
import Header from './components/Header'
import Home from './pages/Home'
import MyBets from './pages/MyBets'
import MarketStatus from './pages/MarketStatus'

export type Tab = 'home' | 'myBets' | 'status'

export default function App() {
  const [tab, setTab] = useState<Tab>('home')

  return (
    <div className="min-h-screen bg-slate-950">
      <Header tab={tab} setTab={setTab} />
      <main className="max-w-3xl mx-auto px-4 pb-16">
        {tab === 'home' && <Home />}
        {tab === 'myBets' && <MyBets />}
        {tab === 'status' && <MarketStatus />}
      </main>
    </div>
  )
}
