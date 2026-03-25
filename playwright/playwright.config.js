const fs = require("fs");
const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

function loadEnvFromFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const fileContent = fs.readFileSync(envPath, "utf8");
  for (const rawLine of fileContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = value;
  }
}

loadEnvFromFile(path.resolve(__dirname, "..", ".env"));

const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
const defaultArtifactsDir = fs.existsSync(path.resolve(__dirname, "..", "artifacts"))
  ? path.resolve(__dirname, "..", "artifacts")
  : path.resolve(__dirname, "artifacts");
const artifactsDir = process.env.ARTIFACTS_DIR || defaultArtifactsDir;
const videoMode = process.env.PLAYWRIGHT_VIDEO || "retain-on-failure";
const screenshotMode = process.env.PLAYWRIGHT_SCREENSHOT || "only-on-failure";
const traceMode = process.env.PLAYWRIGHT_TRACE || "retain-on-failure";

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
    ["html", { outputFolder: path.join(artifactsDir, "playwright-report"), open: "never" }],
    ["json", { outputFile: path.join(artifactsDir, "playwright-report", "results.json") }],
  ],
  outputDir: path.join(artifactsDir, "test-results"),
  use: {
    headless,
    viewport: { width: 1366, height: 768 },
    video: videoMode,
    screenshot: screenshotMode,
    trace: traceMode,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
