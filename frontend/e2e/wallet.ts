import type { Page } from '@playwright/test'

export const OWNER = '0xed2B5717c9b936ecC76d75401026A99143e278F5'
export const NON_OWNER = '0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7'
export const CHAIN_ID_HEX = '0x4cef52' // 5042002 Arc Testnet

/**
 * Injects a read-only EIP-1193 provider.
 *
 * It deliberately implements only account and chain queries; eth_sendTransaction is
 * always rejected. This file holds no private key and performs no signing. Every step
 * that needs a real transaction is done on-chain by scripts/e2e-testnet.ts, with tx
 * hashes as evidence.
 *
 * That is still enough to verify the owner check, the nav bar, the route guard, the
 * preflight invalidation and the warning banner, because all the on-chain reads on
 * those paths go through the app's own /api/rpc transport rather than the wallet.
 */
export async function injectWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ addr, chainId }) => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
      ;(window as unknown as { ethereum: unknown }).ethereum = {
        isMetaMask: true,
        request: async ({ method }: { method: string; params?: unknown }) => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [addr]
            case 'eth_chainId':
              return chainId
            case 'net_version':
              return String(parseInt(chainId, 16))
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null
            case 'eth_sendTransaction':
            case 'personal_sign':
            case 'eth_signTypedData_v4':
              throw Object.assign(new Error('E2E mock provider: signing is not supported'), { code: 4001 })
            default:
              throw Object.assign(new Error(`unsupported: ${method}`), { code: 4200 })
          }
        },
        on: (ev: string, cb: (...a: unknown[]) => void) => {
          ;(listeners[ev] ??= []).push(cb)
        },
        removeListener: (ev: string, cb: (...a: unknown[]) => void) => {
          listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== cb)
        },
      }
    },
    { addr: address, chainId: CHAIN_ID_HEX },
  )
}

export async function connect(page: Page) {
  await page.getByRole('button', { name: /connect wallet/i }).first().click()
  await page.waitForFunction(
    () => !document.body.innerText.match(/Connect Wallet/i),
    undefined,
    { timeout: 20_000 },
  )
}
