import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import Layout from './components/Layout'
import Betting from './pages/Betting'
import MyBets from './pages/MyBets'
import MarketStatus from './pages/MarketStatus'
import Admin from './pages/Admin'
import { useIsOwner } from './hooks/useIsOwner'

/**
 * Route guard for /admin.
 *
 * - Owner check unresolved (wallet reconnecting, owner() RPC in flight) -> do nothing:
 *   render no admin content and do not redirect. Redirecting immediately would bounce
 *   the owner to the home page every time they reload.
 * - Resolved and not the owner (including no wallet connected) -> redirect home, and
 *   never render any part of Admin, so the route's existence is not revealed.
 */
function AdminRoute() {
  const { isOwner, isResolved } = useIsOwner()
  const navigate = useNavigate()

  useEffect(() => {
    if (isResolved && !isOwner) navigate('/betting', { replace: true })
  }, [isResolved, isOwner, navigate])

  if (!isResolved || !isOwner) return null
  return <Admin />
}

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/betting" replace />} />
        <Route path="/betting" element={<Betting />} />
        <Route path="/my-bets" element={<MyBets />} />
        <Route path="/market-status" element={<MarketStatus />} />
        <Route path="/admin" element={<AdminRoute />} />
      </Routes>
    </Layout>
  )
}
