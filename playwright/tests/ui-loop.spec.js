const { test, expect } = require("@playwright/test");

const pageUrl = process.env.PAGE_URL;
const loopCount = Number(process.env.LOOP_COUNT || 20);
const loopDelayMs = Number(process.env.LOOP_DELAY_MS || 1000);

test("loop update page with screenshots and video", async ({ page }, testInfo) => {
  if (!pageUrl) {
    throw new Error("PAGE_URL is required. Set it in .env.");
  }

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  for (let i = 1; i <= loopCount; i += 1) {
    const imageName = `loop-${String(i).padStart(3, "0")}.png`;
    await page.screenshot({
      path: testInfo.outputPath(imageName),
      fullPage: true,
    });

    await expect(page).toHaveURL(/.*/);

    if (i < loopCount) {
      await page.waitForTimeout(loopDelayMs);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
});
