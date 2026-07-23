import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { wagmiConfig } from './lib/wagmi'
import App from './App'
import './index.css'

// retry: false — RPC reads (getMarket, bucketTotals, claimed, allowance, balance, ...) rely on
// this being the only retry layer alongside viem's transport retryCount: 0 (see wagmi.ts) and
// MyBets.tsx's own withRateLimitRetry. TanStack Query's default retry: 3 was a second, independent
// retry mechanism that kept re-triggering the same RPC rate limit underneath those.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>
)
