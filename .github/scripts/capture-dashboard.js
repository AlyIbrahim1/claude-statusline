const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('http://localhost:8080/dashboard.html');

  // Wait until the mockData.jsonl fetch has completed and the table is rendered
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#tableBody tr');

  // Wait for all CSS animations (fadeUp on cards + table section) to finish
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));

  await page.screenshot({ path: 'assets/dashboard-preview.png', fullPage: true });

  await browser.close();
})();
