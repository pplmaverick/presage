import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import Layout from './components/Layout'
import Betting from './pages/Betting'
import MyBets from './pages/MyBets'
import MarketStatus from './pages/MarketStatus'
import Admin from './pages/Admin'
import { useIsOwner } from './hooks/useIsOwner'

/**
 * /admin 的守門。
 *
 * - owner 判定還沒有結論（錢包重連中、owner() RPC 未回）→ 什麼都不做：
 *   不渲染任何 admin 內容，也不導轉。直接導轉會讓 owner 重新整理頁面時
 *   先被踢回首頁。
 * - 有結論且不是 owner（含完全沒連錢包）→ 導回首頁，且自始至終不渲染
 *   Admin 的任何內容，避免讓人看出這條路由存在。
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
