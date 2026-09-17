import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'
import { mkdirSync, writeFileSync } from 'node:fs'

test('evidence capture: admin panel market list + screenshot', async ({ page }) => {
  mkdirSync('e2e/evidence', { recursive: true })
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/Markets \(/, { timeout: 20_000 })
  // Wait for the market list to actually render its rows. The count grows as rounds are
  // created, so assert "at least one row" rather than pinning a number that goes stale.
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 })

  const rows = await page.locator('table tbody tr').evaluateAll((trs) =>
    trs.map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) =>
        (td as HTMLElement).innerText.replace(/\n+/g, ' | ').trim(),
      ),
    ),
  )
  const dump = rows.map((r) => '  ' + r.join('  ||  ')).join('\n')
  console.log('  [evidence] market list as rendered:\n' + dump)
  writeFileSync('e2e/evidence/market-list.txt', dump + '\n')

  await page.screenshot({ path: 'e2e/evidence/admin-panel.png', fullPage: true })

  // Actual values shown in the Fees / Default settlement window cards
  const cards = await page.locator('section').allInnerTexts()
  writeFileSync('e2e/evidence/admin-cards.txt', cards.join('\n---\n'))
  console.log('  [evidence] saved e2e/evidence/{admin-panel.png,market-list.txt,admin-cards.txt}')
})

test('evidence capture: MyBets (non-owner view, before the refund window -> no refund button)', async ({ page }) => {
  await injectWallet(page, '0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7')
  await page.goto('/my-bets')
  await connect(page)
  await page.waitForTimeout(8000)
  const body = await page.locator('body').innerText()
  const hasRefundBtn = /Reclaim Principal/.test(body)
  console.log(`  [evidence] MyBets shows a "Reclaim Principal" button: ${hasRefundBtn}`)
  writeFileSync('e2e/evidence/mybets-before-deadline.txt', body)
  await page.screenshot({ path: 'e2e/evidence/mybets.png', fullPage: true })
  expect(hasRefundBtn, 'the button must not appear before the refund window opens').toBe(false)
})
