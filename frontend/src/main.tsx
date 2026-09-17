import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig, getConfigError } from './lib/wagmi'
import App from './App'
import ConfigErrorScreen from './components/ConfigErrorScreen'
import './index.css'

// retry: false — RPC reads (getMarket, bucketTotals, claimed, allowance, balance, ...) rely on
// this being the only retry layer alongside viem's transport retryCount: 0 (see wagmi.ts) and
// MyBets.tsx's own withRateLimitRetry. TanStack Query's default retry: 3 was a second, independent
// retry mechanism that kept re-triggering the same RPC rate limit underneath those.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

// 合約位址等必填設定缺失時，整頁換成明確的設定錯誤畫面，而不是讓 app 帶著
// 一個 placeholder 位址跑起來。see lib/wagmi.ts 的 requireEnv。
const configError = getConfigError()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {configError ? (
      <ConfigErrorScreen message={configError} />
    ) : (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </WagmiProvider>
    )}
  </StrictMode>
)
