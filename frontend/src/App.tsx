import { useState } from 'react'
import Header from './components/Header'
import Home from './pages/Home'
import MyBets from './pages/MyBets'
import MarketStatus from './pages/MarketStatus'
import WeatherBar from './components/WeatherBar'
import { CITY_MARKETS, CITY_NAMES, type CityName } from './config'

export type Tab = 'home' | 'myBets' | 'status'

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [selectedCity, setSelectedCity] = useState<CityName>('Taipei')
  const marketId = CITY_MARKETS[selectedCity]

  return (
    <div className="min-h-screen bg-slate-950">
      <Header tab={tab} setTab={setTab} />
      <main className="max-w-3xl mx-auto px-4 pb-16">
        {/* City Selector */}
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <span className="text-slate-500 text-xs mr-1">City</span>
          {CITY_NAMES.map(city => (
            <button
              key={city}
              onClick={() => setSelectedCity(city)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border ${
                selectedCity === city
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
            >
              {city}
            </button>
          ))}
        </div>

        <WeatherBar city={selectedCity} />

        {tab === 'home' && <Home marketId={marketId} />}
        {tab === 'myBets' && <MyBets marketId={marketId} />}
        {tab === 'status' && <MarketStatus marketId={marketId} />}
      </main>
    </div>
  )
}
