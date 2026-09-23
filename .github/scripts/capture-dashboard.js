const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto('http://localhost:8080/dashboard.html');

  // Wait until the sample history.js has loaded and the session rows are rendered
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.row');

  await page.screenshot({ path: '.github/assets/dashboard-preview.png' });

  await browser.close();
})();
