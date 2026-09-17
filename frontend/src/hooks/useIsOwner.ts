import { useAccount, useReadContract } from 'wagmi'
import { CONTRACT_ADDRESS } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'

export interface OwnerState {
  /** 連接中的地址是否為 WeatherMarket 的 owner */
  isOwner: boolean
  /**
   * 判定是否已經有結論。false 代表「還不知道」——
   * 錢包正在自動重連，或 owner() 這筆 RPC 還沒回來。
   * 在這之前不可以渲染 ADMIN 入口，也不可以執行導轉，
   * 否則重新整理 /admin 會先被踢回首頁再閃回來。
   */
  isResolved: boolean
  owner: `0x${string}` | undefined
}

export function useIsOwner(): OwnerState {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount()

  const {
    data: owner,
    isLoading,
    isFetched,
  } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: WEATHER_MARKET_ABI,
    functionName: 'owner',
  })

  // 錢包還在連線/重連階段 → 尚未有結論
  if (isConnecting || isReconnecting) {
    return { isOwner: false, isResolved: false, owner: owner as `0x${string}` | undefined }
  }

  // 確定沒連錢包 → 立即有結論：不是 owner
  if (!isConnected || !address) {
    return { isOwner: false, isResolved: true, owner: owner as `0x${string}` | undefined }
  }

  // 有連錢包，但 owner() 還沒回來 → 尚未有結論
  if (isLoading || !isFetched || owner === undefined) {
    return { isOwner: false, isResolved: false, owner: undefined }
  }

  const ownerAddr = owner as `0x${string}`
  return {
    isOwner: ownerAddr.toLowerCase() === address.toLowerCase(),
    isResolved: true,
    owner: ownerAddr,
  }
}
