import { useAccount, useReadContract } from 'wagmi'
import { CONTRACT_ADDRESS } from '../lib/wagmi'
import { WEATHER_MARKET_ABI } from '../abi'

export interface OwnerState {
  /** Whether the connected address is the WeatherMarket owner */
  isOwner: boolean
  /**
   * Whether the check has reached a conclusion. `false` means "not known yet" —
   * the wallet is auto-reconnecting, or the owner() call is still in flight.
   * Until then we must not render the ADMIN entry and must not redirect,
   * otherwise reloading /admin bounces the owner to the home page and back.
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

  // Wallet still connecting / reconnecting -> no conclusion yet
  if (isConnecting || isReconnecting) {
    return { isOwner: false, isResolved: false, owner: owner as `0x${string}` | undefined }
  }

  // Definitively not connected -> immediate conclusion: not the owner
  if (!isConnected || !address) {
    return { isOwner: false, isResolved: true, owner: owner as `0x${string}` | undefined }
  }

  // Connected, but owner() has not returned yet -> no conclusion yet
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
