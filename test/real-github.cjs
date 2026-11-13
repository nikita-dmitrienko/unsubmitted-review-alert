// Leave prompts and themes on real, public github.com pages (logged out, read-only), with GitHub's own
// Turbo/React navigation and keyboard shortcuts. A pending review is simulated by a hidden review-button
// counter, because a real one needs a signed-in account. Run: npm run test:real   (needs network)
// SHOTS_DIR=<folder> also saves a screenshot per theme. HEADED=1 shows the browser window.
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { barContrast, assertReadable } = require('./contrast.cjs');

const EXTENSION_DIR = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '../extension'));
const PR = 'https://github.com/refined-github/sandbox/pull/10';
const PREFIX = '⚠ PENDING REVIEW · ';
const ISSUES_TAB = 'a[data-tab-item="issues"]'; // the repository's Issues tab (React UnderlineNav)

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`  FAIL ${name}\n       ${String(error.message).slice(0, 400)}`);
  }
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const tab = context.pages()[0] || (await context.newPage());
  const dialogs = [];
  let answer = false;
  tab.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    if (answer) await dialog.accept();
    else await dialog.dismiss();
  });
  const bannerShown = () => tab.evaluate(() => document.getElementById('pending-review-nag') !== null);

  // Loads the PR, simulates a pending review, and gives the page one user interaction (Chrome only shows
  // "Leave site?" after one). Clicking the bar's own text is safe: it is not a link or button.
  async function openPending(url = PR) {
    answer = true;
    await tab.goto(url, { waitUntil: 'load' });
    answer = false;
    await tab.evaluate(() => {
      const fake = document.createElement('button');
      fake.className = 'ReviewMenuButton__simulated';
      fake.style.display = 'none';
      fake.innerHTML = '<span data-component="ButtonCounter">2</span>';
      document.body.append(fake);
    });
    await tab.waitForFunction(() => document.getElementById('pending-review-nag') !== null, null, { timeout: 5000 });
    await tab.locator('#pending-review-nag .text').click();
    dialogs.length = 0;
  }

  console.log('Leave prompts on real GitHub pages');
  await test('clicking the repo Issues tab asks; Cancel keeps you on the PR with the bar', async () => {
    await openPending();
    await tab.click(ISSUES_TAB);
    await tab.waitForTimeout(1000);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(tab.url(), PR);
    assert.equal(await bannerShown(), true);
  });
  await test('OK on that question leaves via GitHub navigation, asks only once, clears bar and title', async () => {
    await openPending();
    answer = true;
    await tab.click(ISSUES_TAB);
    await tab.waitForURL('**/refined-github/sandbox/issues', { timeout: 10000 });
    await tab.waitForTimeout(1000);
    answer = false;
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(await bannerShown(), false);
    assert.ok(!(await tab.title()).includes(PREFIX));
  });
  for (const [tabName, selector, urlGlob] of [
    ['Commits', '#prs-commits-anchor-tab', '**/pull/10/commits'],
    ['Files changed', '#prs-files-anchor-tab', '**/pull/10/files'],
  ]) {
    await test(`another tab of the same PR (${tabName}) does not ask`, async () => {
      await openPending();
      await tab.evaluate(() => { window.samePageMarker = true; });
      await tab.click(selector);
      await tab.waitForURL(urlGlob, { timeout: 10000 });
      await tab.waitForTimeout(1500);
      assert.deepEqual(dialogs, []);
      // In-app navigation keeps the bar. A full page load drops the simulated counter, which is expected:
      // a real pending review is rendered again on the new page.
      const inApp = await tab.evaluate(() => window.samePageMarker === true);
      console.log(`       ${inApp ? 'in-app navigation' : 'full page load'}; bar ${(await bannerShown()) ? 'kept' : 'gone'}`);
      if (inApp) assert.equal(await bannerShown(), true);
    });
  }
  await test('keyboard: Enter on the focused Issues tab asks', async () => {
    await openPending();
    await tab.focus(ISSUES_TAB);
    await tab.keyboard.press('Enter');
    await tab.waitForTimeout(1000);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(tab.url(), PR);
  });
  await test("GitHub's own keyboard shortcut (g then i, go to Issues) asks", async () => {
    await openPending();
    await tab.focus('body');
    await tab.keyboard.press('g');
    await tab.keyboard.press('i');
    await tab.waitForTimeout(1500);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(tab.url(), PR);
  });
  await test('reload shows Chrome\'s native prompt', async () => {
    await openPending();
    await tab.reload({ timeout: 2000 }).catch(() => {});
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(await bannerShown(), true);
  });
  await test('closing the tab shows the native prompt; Cancel keeps it open', async () => {
    await openPending();
    await tab.close({ runBeforeUnload: true });
    await tab.waitForTimeout(1500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(tab.isClosed(), false);
  });
  await test('typing another address shows the native prompt', async () => {
    await openPending();
    await tab.goto('https://example.com/', { timeout: 2000 }).catch(() => {});
    await tab.waitForTimeout(500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(tab.url(), PR);
  });
  await test('a link to another site (docs.github.com in the footer) gets only the native prompt', async () => {
    await openPending();
    await tab.click('footer a[href^="https://docs.github.com"]');
    await tab.waitForTimeout(1500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(tab.url(), PR);
  });
  await test('Cmd/Ctrl-click on Issues opens a new tab without asking', async () => {
    await openPending();
    const popup = context.waitForEvent('page', { timeout: 5000 });
    await tab.click(ISSUES_TAB, { modifiers: ['ControlOrMeta'] });
    await (await popup).close();
    assert.deepEqual(dialogs, []);
    assert.equal(tab.url(), PR);
  });
  // Enters a PR from the PR list by GitHub's in-app navigation (no page load), then simulates a pending review.
  async function enterPrInApp() {
    answer = true;
    await tab.goto('https://github.com/refined-github/sandbox/pulls', { waitUntil: 'load' });
    answer = false;
    await tab.evaluate(() => { window.samePageMarker = true; });
    await tab.locator('a[href*="/refined-github/sandbox/pull/"]:visible').first().click();
    await tab.waitForURL('**/pull/*', { timeout: 10000 });
    await tab.waitForTimeout(1500);
    assert.equal(await tab.evaluate(() => window.samePageMarker === true), true, 'expected in-app navigation');
    await tab.evaluate(() => {
      const fake = document.createElement('button');
      fake.className = 'ReviewMenuButton__simulated';
      fake.style.display = 'none';
      fake.innerHTML = '<span data-component="ButtonCounter">2</span>';
      document.body.append(fake);
    });
    await tab.waitForFunction(() => document.getElementById('pending-review-nag') !== null, null, { timeout: 5000 });
    await tab.locator('#pending-review-nag .text').click();
    dialogs.length = 0;
    return tab.url();
  }
  // What GitHub shows, to prove URL and view agree: the PR page has a merge-status header, the list does not.
  const showsPr = () => tab.evaluate(() => /Pull Request #\d+/.test(document.title));
  await test('Back after entering the PR in-app asks; Cancel keeps URL and GitHub view on the PR', async () => {
    const prUrl = await enterPrInApp();
    await tab.goBack({ timeout: 3000 }).catch(() => {});
    await tab.waitForTimeout(1500);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(tab.url(), prUrl);
    assert.equal(await showsPr(), true, `view no longer shows the PR: ${await tab.title()}`);
    assert.equal(await bannerShown(), true);
  });
  await test('Back after entering the PR in-app: OK goes back to the list, URL and view agree', async () => {
    await enterPrInApp();
    answer = true;
    await tab.goBack({ timeout: 3000 }).catch(() => {});
    await tab.waitForURL('**/refined-github/sandbox/pulls', { timeout: 10000 });
    await tab.waitForTimeout(1500);
    answer = false;
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(await showsPr(), false, `view still shows a PR: ${await tab.title()}`);
    assert.equal(await bannerShown(), false);
  });

  console.log('Theme on real GitHub pages (GitHub\'s own Primer CSS)');
  for (const [label, mode, light, dark, scheme] of [
    ['GitHub light', 'light', 'light', 'dark', 'light'],
    ['GitHub dark', 'dark', 'light', 'dark', 'light'],
    ['GitHub dark high contrast', 'dark', 'light', 'dark_high_contrast', 'light'],
    ['GitHub light high contrast', 'light', 'light_high_contrast', 'dark', 'light'],
    ['Sync with system, system dark', 'auto', 'light', 'dark', 'dark'],
  ]) {
    await test(`${label}: bar follows the theme and passes WCAG AA`, async () => {
      await tab.emulateMedia({ colorScheme: scheme });
      await openPending();
      await tab.evaluate(([m, l, d]) => {
        const html = document.documentElement;
        html.dataset.colorMode = m;
        html.dataset.lightTheme = l;
        html.dataset.darkTheme = d;
      }, [mode, light, dark]);
      await tab.waitForTimeout(2000);
      const page = await tab.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const c = await tab.evaluate(barContrast);
      console.log(`       page ${page}, bar ${c.background}, contrast ${JSON.stringify(c)}`);
      assertReadable(assert, c, label);
      // The bar must be dark on a dark page and light on a light page.
      const lightness = (rgb) => rgb.match(/\d+/g).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
      assert.equal(lightness(c.background) > 128, lightness(page) > 128, `bar ${c.background} vs page ${page}`);
      if (process.env.SHOTS_DIR) {
        await tab.screenshot({ path: path.join(process.env.SHOTS_DIR, `theme-${label.replace(/\W+/g, '-').toLowerCase()}.png`) });
      }
    });
  }
  await tab.emulateMedia({ colorScheme: 'light' });

  await context.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
