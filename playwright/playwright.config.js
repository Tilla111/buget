const { defineConfig, devices } = require("@playwright/test");

const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "artifacts/playwright-report", open: "never" }],
  ],
  outputDir: "artifacts/test-results",
  use: {
    headless,
    viewport: { width: 1366, height: 768 },
    video: "on",
    screenshot: "off",
    trace: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
