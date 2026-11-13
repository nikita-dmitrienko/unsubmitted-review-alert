// Smoke test on real, public github.com PR pages (logged out, read-only): the extension must
// stay silent, and one detection pass must stay cheap with 6x CPU throttling.
// Run: npm run test:smoke   (needs network)
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION_DIR = path.resolve(__dirname, '../extension');
const PAGES = [
  'https://github.com/refined-github/sandbox/pull/10',
  'https://github.com/refined-github/sandbox/pull/10/files',
  'https://github.com/nodejs/node/pull/50000',
  'https://github.com/hotwired/turbo/pull/1000/files',
];

// Copy of the selectors extension/content.js queries per check (keep in sync), timed in the page.
function timeDetectionPass(iterations) {
  const selectors = [
    'button[class*="ReviewMenuButton"]',
    '[data-testid="pending-badge"]',
    '.is-review-pending',
    '.js-pending-review-comment-count',
    '.js-pending-review-comment',
    'react-app[app-name="repo"] script[data-target="react-app.embeddedData"]',
    '[role="dialog"][aria-label="Review changes"], [role="dialog"][aria-labelledby="anchored-review-title"]',
  ];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    for (const selector of selectors) document.querySelectorAll(selector).length;
  }
  return { msPerPass: (performance.now() - start) / iterations, elements: document.getElementsByTagName('*').length };
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(tab);
  let failed = 0;

  for (const url of PAGES) {
    await tab.goto(url, { waitUntil: 'load' });
    await tab.waitForTimeout(1500);
    const banner = await tab.evaluate(() => document.getElementById('pending-review-nag') !== null);
    const title = await tab.title();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const timing = await tab.evaluate(timeDetectionPass, 50);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const silent = !banner && !title.includes('PENDING REVIEW');
    if (!silent) failed++;
    console.log(
      `${silent ? 'ok  ' : 'FAIL'} ${url}\n     banner=${banner} elements=${timing.elements} ` +
        `detection pass at 6x throttle=${timing.msPerPass.toFixed(2)} ms`,
    );
  }
  console.log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
  await context.close();
  process.exit(failed ? 1 : 0);
})();
