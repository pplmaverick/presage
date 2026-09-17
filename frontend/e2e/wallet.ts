import type { Page } from '@playwright/test'

export const OWNER = '0xed2B5717c9b936ecC76d75401026A99143e278F5'
export const NON_OWNER = '0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7'
export const CHAIN_ID_HEX = '0x4cef52' // 5042002 Arc Testnet

/**
 * 注入一個「唯讀」的 EIP-1193 provider。
 *
 * 這裡刻意只實作帳號/鏈別查詢，eth_sendTransaction 一律拒絕：
 * 本檔案不持有任何私鑰，也不做任何簽章。需要真的送交易的步驟
 * 全部由 scripts/e2e-testnet.ts 在鏈上完成（有 tx hash 為證）。
 *
 * 這樣仍足以驗證 owner 判定、導覽列、路由守門、預飛失效、警告橫幅——
 * 因為這些路徑的鏈上讀取全部走 app 自己的 /api/rpc transport，不經過錢包。
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
              throw Object.assign(new Error('E2E mock provider: 不做簽章'), { code: 4001 })
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
