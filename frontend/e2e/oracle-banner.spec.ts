import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'

// 這支要在「VITE_ADMIN_ORACLE_TESTNET 被改成錯誤位址」的 dev server 上跑
test('i. AdminOracle 位址錯誤時顯示警告橫幅', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/建立市場/, { timeout: 20_000 })

  await expect(page.locator('body')).toContainText(
    /WeatherMarket\.oracle = .*不符/,
    { timeout: 30_000 },
  )
  const body = await page.locator('body').innerText()
  console.log('  [i] 橫幅內容:\n' + body.split('\n').filter((l) => /⚠/.test(l)).map((l) => '      ' + l).join('\n'))
})

test('i. AdminOracle 位址正確時警告消失', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/建立市場/, { timeout: 20_000 })
  await page.waitForTimeout(4000)

  const body = await page.locator('body').innerText()
  expect(body, '不該出現 oracle 不符警告').not.toMatch(/WeatherMarket\.oracle = .*不符/)
  expect(body, '不該出現未設定警告').not.toMatch(/未設定 VITE_ADMIN_ORACLE/)
  expect(body, '不該出現 owner 不符警告').not.toMatch(/AdminOracle\.owner = .*不是目前連接的地址/)
  const warns = body.split('\n').filter((l) => /⚠/.test(l) && !/僅影響之後新建立的市場/.test(l))
  console.log('  [i] 正確位址下的殘留警告行數:', warns.length, warns)
  expect(warns.length).toBe(0)
})
