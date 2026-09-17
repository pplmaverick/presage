import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    headless: true,
  },
})
