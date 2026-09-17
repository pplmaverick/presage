import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'
import { writeFileSync } from 'node:fs'

test('g. 提交結果流程：取得溫度 → 顯示原始/四捨五入/city 來源（不簽章）', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('table tbody tr')).toHaveCount(4, { timeout: 30_000 })

  // LOCKED 且未逾時的市場才會有「取得溫度」
  const btn = page.getByRole('button', { name: '取得溫度' }).first()
  await expect(btn).toBeVisible()
  await btn.click()

  // 顯示「原始溫度 → 送出整數」與 city 來源
  const row = page.locator('table tbody tr').filter({ hasText: '確認提交' }).first()
  await expect(row).toContainText(/→ 送出/, { timeout: 20_000 })
  const text = await row.innerText()
  console.log('  [g] 溫度確認畫面:\n' + text.split('\n').map((l) => '      ' + l).join('\n'))
  writeFileSync('e2e/evidence/submit-flow.txt', text)

  // 原始溫度 → 四捨五入的一致性
  const m = text.match(/([-\d.]+)°C\s*→\s*送出\s*(-?\d+)/)
  expect(m, '找不到「原始溫度 → 送出整數」').not.toBeNull()
  const raw = Number(m![1]), rounded = Number(m![2])
  console.log(`  [g] 原始 ${raw} → 畫面顯示送出 ${rounded}；Math.round(${raw}) = ${Math.round(raw)}`)
  expect(rounded).toBe(Math.round(raw))

  // city 必須標明來自鏈上，且整個流程沒有任何 city 輸入框
  await expect(row).toContainText(/city="(Taipei|Tokyo|Bangkok|Seoul)"（鏈上讀回）/)
  const inputsInRow = await row.locator('input, select').count()
  console.log(`  [g] 溫度確認區塊內的 input/select 數量: ${inputsInRow}（必須為 0，city 不可手動輸入）`)
  expect(inputsInRow).toBe(0)

  await page.screenshot({ path: 'e2e/evidence/submit-flow.png', fullPage: true })

  // 按「確認提交」→ mock provider 拒簽，驗證它確實走到送交易那一步
  await row.getByRole('button', { name: '確認提交' }).click()
  await page.waitForTimeout(3000)
  const after = await row.innerText()
  console.log('  [g] 按下確認提交後（mock 錢包拒簽）:\n' + after.split('\n').map((l) => '      ' + l).join('\n'))
})
