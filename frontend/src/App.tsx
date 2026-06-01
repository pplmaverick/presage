import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Betting from './pages/Betting'
import MyBets from './pages/MyBets'
import MarketStatus from './pages/MarketStatus'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/betting" replace />} />
        <Route path="/betting" element={<Betting />} />
        <Route path="/my-bets" element={<MyBets />} />
        <Route path="/market-status" element={<MarketStatus />} />
      </Routes>
    </Layout>
  )
}
