// Renders DRAFT store images into store/assets/ with the real extension loaded:
// a 1280x800 screenshot of a public PR with the banner, and the 440x280 small promo tile.
// The screenshot fakes a pending review by adding a hidden review-button counter to the page.
// Replace it with a signed-in screenshot of a real pending review before submitting.
// Run: npm run store-images   (needs network and ImageMagick)
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const ASSETS = path.join(ROOT, 'store/assets');
const SCREENSHOT_PR = 'https://github.com/refined-github/sandbox/pull/10/files';

const PROMO_HTML = `<!doctype html><html><body style="margin:0">
  <div style="width:440px;height:280px;display:flex;align-items:center;justify-content:center;gap:22px;
              background:linear-gradient(135deg,#2d333b,#161b22);font:700 30px/1.15 -apple-system,Helvetica,Arial,sans-serif;color:#fff">
    <img src="data:image/png;base64,ICON" width="112" height="112" alt="">
    <div>Submit<br>your review</div>
  </div></body></html>`;

function flatten(file) {
  // Store image widgets are reported to reject alpha channels; flatten to be safe.
  execFileSync('magick', [file, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', file]);
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const tab = await context.newPage();

  await tab.goto(SCREENSHOT_PR, { waitUntil: 'load' });
  await tab.evaluate(() => {
    const fake = document.createElement('button');
    fake.className = 'ReviewMenuButton__draft';
    fake.style.display = 'none';
    fake.innerHTML = '<span data-component="ButtonCounter">3</span>';
    document.body.append(fake);
  });
  await tab.waitForFunction(() => document.getElementById('pending-review-nag') !== null, null, { timeout: 5000 });
  const screenshot = path.join(ASSETS, 'screenshot-1-banner-DRAFT.png');
  await tab.screenshot({ path: screenshot });
  flatten(screenshot);

  const icon = require('node:fs').readFileSync(path.join(EXTENSION_DIR, 'icons/icon-128.png')).toString('base64');
  await tab.setViewportSize({ width: 440, height: 280 });
  await tab.setContent(PROMO_HTML.replace('ICON', icon));
  const promo = path.join(ASSETS, 'promo-small-440x280.png');
  await tab.screenshot({ path: promo, clip: { x: 0, y: 0, width: 440, height: 280 } });
  flatten(promo);

  await context.close();
  console.log(`Wrote ${screenshot}\nWrote ${promo}`);
})();
