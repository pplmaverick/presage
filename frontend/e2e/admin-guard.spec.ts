import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER, NON_OWNER } from './wallet'

// admin 面板專屬的字串，用來確認「有沒有洩漏任何 admin 內容」
const ADMIN_ONLY_TEXT = [/建立市場/, /預設結算期/, /市場列表/, /手續費/]

async function expectNoAdminContent(page: import('@playwright/test').Page) {
  const body = await page.locator('body').innerText()
  for (const re of ADMIN_ONLY_TEXT) {
    expect(body, `不該出現 admin 內容 ${re}`).not.toMatch(re)
  }
  expect(body, '導覽列不該出現 ADMIN 標籤').not.toMatch(/\bADMIN\b/)
}

test.describe('a. 未連接錢包', () => {
  test('導覽列無 ADMIN，直接打 /admin 被導回首頁且不洩漏任何內容', async ({ page }) => {
    const seen: string[] = []
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()) })

    await page.goto('/admin')
    await page.waitForLoadState('networkidle')

    // 導轉到 /betting
    await expect(page).toHaveURL(/\/betting$/)
    await expectNoAdminContent(page)
    console.log('  [a] 導航序列:', seen.map((u) => new URL(u).pathname).join(' → '))
  })

  test('首頁導覽列（桌機/側邊欄/手機）都沒有 ADMIN', async ({ page }) => {
    await page.goto('/betting')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('link', { name: 'ADMIN' })).toHaveCount(0)
    await expectNoAdminContent(page)
  })
})

test.describe('a. 非 owner 錢包', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, NON_OWNER) })

  test('連線後導覽列仍無 ADMIN', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.waitForTimeout(3000) // 讓 owner() 讀取回來
    await expect(page.getByRole('link', { name: 'ADMIN' })).toHaveCount(0)
    await expectNoAdminContent(page)
  })

  test('直接打 /admin 被導回首頁，過程不閃現 admin 內容', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)

    // 一邊導航一邊連續取樣畫面內容，確認沒有任何一幀出現 admin 內容
    const samples: string[] = []
    const sampler = setInterval(async () => {
      try { samples.push(await page.locator('body').innerText()) } catch { /* 導航中 */ }
    }, 50)

    await page.goto('/admin')
    await page.waitForURL(/\/betting$/, { timeout: 20_000 })
    await page.waitForTimeout(2000)
    clearInterval(sampler)

    const leaked = samples.filter((s) => ADMIN_ONLY_TEXT.some((re) => re.test(s)))
    console.log(`  [a] 取樣 ${samples.length} 幀，洩漏 admin 內容的幀數: ${leaked.length}`)
    expect(leaked.length, 'admin 內容曾閃現').toBe(0)
    await expectNoAdminContent(page)
  })
})

test.describe('b. owner 錢包', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, OWNER) })

  test('導覽列出現 ADMIN，可進入面板', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)

    const adminLink = page.getByRole('link', { name: 'ADMIN' }).first()
    await expect(adminLink).toBeVisible({ timeout: 20_000 })

    await adminLink.click()
    await expect(page).toHaveURL(/\/admin$/)
    for (const re of [/建立市場/, /預設結算期/, /市場列表/, /手續費/]) {
      await expect(page.locator('body')).toContainText(re)
    }
  })

  test('面板讀到鏈上真實資料（市場列表 / defaultLockedTimeout / MIN-MAX）', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.goto('/admin')
    await expect(page.locator('body')).toContainText(/建立市場/, { timeout: 20_000 })

    // 這條鏈上目前有 4 個市場（#0~#3，由 scripts/e2e-testnet.ts 建立）
    await expect(page.locator('body')).toContainText(/市場列表（4）/, { timeout: 30_000 })
    await expect(page.locator('body')).toContainText(/defaultLockedTimeout/)
    await expect(page.locator('body')).toContainText(/允許範圍 1 天 ～ 30 天/)
    await expect(page.locator('body')).toContainText(/3 天/) // defaultLockedTimeout = 259200

    const body = await page.locator('body').innerText()
    console.log('  [b] 市場列表節錄:\n' + body.split('\n').filter((l) =>
      /Taipei|Tokyo|OPEN|LOCKED|SETTLED|市場列表/.test(l)).slice(0, 20).map((l) => '      ' + l).join('\n'))
  })
})

test.describe('d. simulateContract 預飛結果失效', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, OWNER) })

  test('預飛通過後改動欄位，送出按鈕重新變回 disabled', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.goto('/admin')
    await expect(page.locator('body')).toContainText(/建立市場/, { timeout: 20_000 })

    const preflightBtn = page.getByRole('button', { name: /預飛/ })
    const submitBtn = page.getByRole('button', { name: /送出交易/ })
    const bucketsInput = page.locator('input').filter({ hasText: '' }).first()

    // 初始：送出應為 disabled
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] 初始狀態：送出按鈕 disabled ✓')

    // 預飛
    await preflightBtn.click()
    await expect(page.locator('body')).toContainText(/✓ 預飛通過/, { timeout: 30_000 })
    await expect(submitBtn).toBeEnabled()
    console.log('  [d] 預飛通過後：送出按鈕 enabled ✓')

    // 改動 buckets 欄位 → 預飛結果必須失效
    await bucketsInput.fill('25, 28, 31, 35')
    await expect(page.locator('body')).not.toContainText(/✓ 預飛通過/)
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] 改動欄位後：預飛標記消失、送出按鈕重新 disabled ✓')

    // 改動下拉選單也要失效
    await preflightBtn.click()
    await expect(page.locator('body')).toContainText(/✓ 預飛通過/, { timeout: 30_000 })
    await page.locator('select').nth(1).selectOption({ label: '7 天' }) // 下注期
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] 改動下注期下拉後：送出按鈕重新 disabled ✓')
  })
})
