import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'
import { mkdirSync, writeFileSync } from 'node:fs'

test('證據擷取：admin 面板市場列表 + 截圖', async ({ page }) => {
  mkdirSync('e2e/evidence', { recursive: true })
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText(/市場列表/, { timeout: 20_000 })
  // 等市場列表真的渲染出資料列
  await expect(page.locator('table tbody tr')).toHaveCount(4, { timeout: 30_000 })

  const rows = await page.locator('table tbody tr').evaluateAll((trs) =>
    trs.map((tr) =>
      Array.from(tr.querySelectorAll('td')).map((td) =>
        (td as HTMLElement).innerText.replace(/\n+/g, ' | ').trim(),
      ),
    ),
  )
  const dump = rows.map((r) => '  ' + r.join('  ||  ')).join('\n')
  console.log('  [證據] 市場列表實際渲染:\n' + dump)
  writeFileSync('e2e/evidence/market-list.txt', dump + '\n')

  await page.screenshot({ path: 'e2e/evidence/admin-panel.png', fullPage: true })

  // 手續費 / 預設結算期區塊的實際數值
  const cards = await page.locator('section').allInnerTexts()
  writeFileSync('e2e/evidence/admin-cards.txt', cards.join('\n---\n'))
  console.log('  [證據] 已存 e2e/evidence/{admin-panel.png,market-list.txt,admin-cards.txt}')
})

test('證據擷取：MyBets（非 owner 視角，尚未到退款窗口 → 不顯示申請退款）', async ({ page }) => {
  await injectWallet(page, '0x1183bba65Af0D9Eb695Ccc7B0E2a5796Cb4886E7')
  await page.goto('/my-bets')
  await connect(page)
  await page.waitForTimeout(8000)
  const body = await page.locator('body').innerText()
  const hasRefundBtn = /申請退款/.test(body)
  console.log(`  [證據] MyBets 出現「申請退款」按鈕: ${hasRefundBtn}（此刻退款窗口未開，預期 false）`)
  writeFileSync('e2e/evidence/mybets-before-deadline.txt', body)
  await page.screenshot({ path: 'e2e/evidence/mybets.png', fullPage: true })
  expect(hasRefundBtn, '退款窗口未開時不該出現按鈕').toBe(false)
})
