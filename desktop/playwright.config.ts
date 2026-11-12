import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 940 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.NOVA_TEST_BROWSER
      ? { executablePath: process.env.NOVA_TEST_BROWSER }
      : {},
  },
  webServer: {
    command: "npm run dev:ui",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
