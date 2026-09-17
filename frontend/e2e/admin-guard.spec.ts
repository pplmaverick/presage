import { test, expect } from '@playwright/test'
import { injectWallet, connect, OWNER, NON_OWNER } from './wallet'

// Strings unique to the admin panel, used to assert that no admin content leaks
const ADMIN_ONLY_TEXT = [/Create market/, /Default settlement window/, /Markets \(/, /Withdraw fees/]

async function expectNoAdminContent(page: import('@playwright/test').Page) {
  const body = await page.locator('body').innerText()
  for (const re of ADMIN_ONLY_TEXT) {
    expect(body, `admin content ${re} must not appear`).not.toMatch(re)
  }
  expect(body, 'the ADMIN nav entry must not appear').not.toMatch(/\bADMIN\b/)
}

test.describe('a. no wallet connected', () => {
  test('no ADMIN in nav; visiting /admin redirects home and leaks nothing', async ({ page }) => {
    const seen: string[] = []
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()) })

    await page.goto('/admin')
    await page.waitForLoadState('networkidle')

    // redirected to /betting
    await expect(page).toHaveURL(/\/betting$/)
    await expectNoAdminContent(page)
    console.log('  [a] navigation sequence:', seen.map((u) => new URL(u).pathname).join(' -> '))
  })

  test('no ADMIN in any nav (desktop / sidebar / mobile)', async ({ page }) => {
    await page.goto('/betting')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('link', { name: 'ADMIN' })).toHaveCount(0)
    await expectNoAdminContent(page)
  })
})

test.describe('a. non-owner wallet', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, NON_OWNER) })

  test('still no ADMIN in nav after connecting', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.waitForTimeout(3000) // let the owner() read come back
    await expect(page.getByRole('link', { name: 'ADMIN' })).toHaveCount(0)
    await expectNoAdminContent(page)
  })

  test('visiting /admin redirects home without flashing admin content', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)

    // Sample the rendered text continuously during navigation to prove no frame shows admin content
    const samples: string[] = []
    const sampler = setInterval(async () => {
      try { samples.push(await page.locator('body').innerText()) } catch { /* mid-navigation */ }
    }, 50)

    await page.goto('/admin')
    await page.waitForURL(/\/betting$/, { timeout: 20_000 })
    await page.waitForTimeout(2000)
    clearInterval(sampler)

    const leaked = samples.filter((s) => ADMIN_ONLY_TEXT.some((re) => re.test(s)))
    console.log(`  [a] sampled ${samples.length} frames, frames leaking admin content: ${leaked.length}`)
    expect(leaked.length, 'admin content flashed during redirect').toBe(0)
    await expectNoAdminContent(page)
  })
})

test.describe('b. owner wallet', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, OWNER) })

  test('ADMIN appears in nav and opens the panel', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)

    const adminLink = page.getByRole('link', { name: 'ADMIN' }).first()
    await expect(adminLink).toBeVisible({ timeout: 20_000 })

    await adminLink.click()
    await expect(page).toHaveURL(/\/admin$/)
    for (const re of [/Create market/, /Default settlement window/, /Markets \(/, /Withdraw fees/]) {
      await expect(page.locator('body')).toContainText(re)
    }
  })

  test('panel reads real on-chain data (market list / defaultLockedTimeout / MIN-MAX)', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.goto('/admin')
    await expect(page.locator('body')).toContainText(/Create market/, { timeout: 20_000 })

    // The market count grows over time as rounds are created, so assert the list renders
    // with some count rather than pinning a number that goes stale.
    await expect(page.locator('body')).toContainText(/Markets \(\d+\)/, { timeout: 30_000 })
    await expect(page.locator('body')).toContainText(/defaultLockedTimeout/)
    await expect(page.locator('body')).toContainText(/Allowed range 1d – 30d/)
    await expect(page.locator('body')).toContainText(/3d/) // defaultLockedTimeout = 259200

    const body = await page.locator('body').innerText()
    console.log('  [b] market list excerpt:\n' + body.split('\n').filter((l) =>
      /Taipei|Tokyo|OPEN|LOCKED|SETTLED|Markets \(/.test(l)).slice(0, 20).map((l) => '      ' + l).join('\n'))
  })
})

test.describe('d. simulateContract preflight invalidation', () => {
  test.beforeEach(async ({ page }) => { await injectWallet(page, OWNER) })

  test('changing a field after a passing preflight disables submit again', async ({ page }) => {
    await page.goto('/betting')
    await connect(page)
    await page.goto('/admin')
    await expect(page.locator('body')).toContainText(/Create market/, { timeout: 20_000 })

    const preflightBtn = page.getByRole('button', { name: /Preflight/ })
    const submitBtn = page.getByRole('button', { name: /Send transaction/ })
    const bucketsInput = page.locator('input').filter({ hasText: '' }).first()

    // Initially the submit button must be disabled
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] initial state: submit disabled ✓')

    // Run the preflight
    await preflightBtn.click()
    await expect(page.locator('body')).toContainText(/✓ Preflight passed/, { timeout: 30_000 })
    await expect(submitBtn).toBeEnabled()
    console.log('  [d] after a passing preflight: submit enabled ✓')

    // Editing the buckets field must invalidate the preflight result
    await bucketsInput.fill('25, 28, 31, 35')
    await expect(page.locator('body')).not.toContainText(/✓ Preflight passed/)
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] after editing a field: preflight badge gone, submit disabled again ✓')

    // Changing a dropdown must invalidate it too
    await preflightBtn.click()
    await expect(page.locator('body')).toContainText(/✓ Preflight passed/, { timeout: 30_000 })
    await page.locator('select').nth(1).selectOption({ label: '7 days' }) // betting window
    await expect(submitBtn).toBeDisabled()
    console.log('  [d] after changing the betting-window dropdown: submit disabled again ✓')
  })
})
