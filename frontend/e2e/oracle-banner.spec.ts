import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'

// Run this against a dev server where VITE_ADMIN_ORACLE_TESTNET points at a wrong address
test('i. warning banner appears when the AdminOracle address is wrong', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/Create market/, { timeout: 20_000 })

  await expect(page.locator('body')).toContainText(
    /WeatherMarket\.oracle = .*does not match/,
    { timeout: 30_000 },
  )
  const body = await page.locator('body').innerText()
  console.log('  [i] banner contents:\n' + body.split('\n').filter((l) => /⚠/.test(l)).map((l) => '      ' + l).join('\n'))
})

test('i. warning disappears when the AdminOracle address is correct', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/Create market/, { timeout: 20_000 })
  await page.waitForTimeout(4000)

  const body = await page.locator('body').innerText()
  expect(body, 'no oracle-mismatch warning expected').not.toMatch(/WeatherMarket\.oracle = .*does not match/)
  expect(body, 'no not-set warning expected').not.toMatch(/VITE_ADMIN_ORACLE\w* is not set/)
  expect(body, 'no owner-mismatch warning expected').not.toMatch(/AdminOracle\.owner = .*is not the connected address/)
  const warns = body.split('\n').filter((l) => /⚠/.test(l) && !/Affects newly created markets only/.test(l))
  console.log('  [i] leftover warning lines with the correct address:', warns.length, warns)
  expect(warns.length).toBe(0)
})
