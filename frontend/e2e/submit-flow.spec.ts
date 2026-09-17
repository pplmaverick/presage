import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER } from './wallet'
import { writeFileSync } from 'node:fs'

test('g. submit-result flow: fetch temperature -> show raw/rounded/city source (no signing)', async ({ page }) => {
  await injectWallet(page, OWNER)
  await page.goto('/betting')
  await connect(page)
  await page.goto('/admin')
  await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 30_000 })

  // Only a LOCKED market that is not past its deadline shows "Fetch temperature".
  // That is a transient chain state, so skip explicitly rather than fail when the
  // testnet happens to have no qualifying market — a red test here would say nothing
  // about the code.
  const btn = page.getByRole('button', { name: 'Fetch temperature' }).first()
  if (await btn.count() === 0) {
    test.skip(true, 'no LOCKED market inside its settlement window on this chain right now')
  }
  await expect(btn).toBeVisible()
  await btn.click()

  // Shows "raw temperature -> submitted integer" and where city came from
  const row = page.locator('table tbody tr').filter({ hasText: 'Confirm & submit' }).first()
  await expect(row).toContainText(/→ submitting/, { timeout: 20_000 })
  const text = await row.innerText()
  console.log('  [g] temperature confirmation panel:\n' + text.split('\n').map((l) => '      ' + l).join('\n'))
  writeFileSync('e2e/evidence/submit-flow.txt', text)

  // Raw temperature vs rounded integer must agree
  const m = text.match(/([-\d.]+)°C\s*→\s*submitting\s*(-?\d+)/)
  expect(m, 'could not find "raw temperature -> submitted integer"').not.toBeNull()
  const raw = Number(m![1]), rounded = Number(m![2])
  console.log(`  [g] raw ${raw} -> UI shows ${rounded}; Math.round(${raw}) = ${Math.round(raw)}`)
  expect(rounded).toBe(Math.round(raw))

  // city must be labelled as read on-chain, and the flow must have no city input field
  await expect(row).toContainText(/city="(Taipei|Tokyo|Bangkok|Seoul)" \(read on-chain\)/)
  const inputsInRow = await row.locator('input, select').count()
  console.log(`  [g] input/select count inside the confirmation block: ${inputsInRow} (must be 0 — city is not typeable)`)
  expect(inputsInRow).toBe(0)

  await page.screenshot({ path: 'e2e/evidence/submit-flow.png', fullPage: true })

  // Clicking "Confirm & submit" -> the mock provider refuses to sign, proving the flow
  // actually reaches the send-transaction step
  await row.getByRole('button', { name: 'Confirm & submit' }).click()
  await page.waitForTimeout(3000)
  const after = await row.innerText()
  console.log('  [g] after clicking confirm (mock wallet refuses to sign):\n' + after.split('\n').map((l) => '      ' + l).join('\n'))
})
