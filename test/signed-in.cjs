// Checks the extension on a REAL signed-in pending review. Opens a visible Chrome for Testing window with
// the extension loaded; you sign in to GitHub there yourself, then the checks run on PR_URL.
// PR_URL must be a PR where your account has a pending review with at least one comment.
// SUBMIT=1 also submits that review as a plain comment at the end (to check that everything clears).
// Run: PR_URL=https://github.com/<you>/<repo>/pull/<n> PROFILE_DIR=<folder> OUT_DIR=<folder> node test/signed-in.cjs
// PROFILE_DIR keeps your GitHub session cookie: delete that folder when you are done.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const EXTENSION_DIR = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '../extension'));
const PR_URL = process.env.PR_URL;
const PROFILE_DIR = process.env.PROFILE_DIR;
const OUT_DIR = process.env.OUT_DIR || '.';
const PREFIX = '⚠ PENDING REVIEW · ';
if (!PR_URL || !PROFILE_DIR) throw new Error('Set PR_URL and PROFILE_DIR');

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

// Every pending-review signal the extension knows about, as GitHub renders it for a signed-in user.
function signals() {
  const button = document.querySelector('button[class*="ReviewMenuButton"]');
  const host = document.getElementById('pending-review-nag');
  const embedded = document.querySelector('react-app[app-name="repo"] script[data-target="react-app.embeddedData"]');
  let embeddedComments = null;
  try {
    const review = JSON.parse(embedded.textContent).payload.pullRequestsLayoutRoute.viewerPendingReview;
    embeddedComments = review && review.comments ? review.comments.length : 0;
  } catch { /* not present on this route */ }
  return {
    path: location.pathname,
    reviewButton: button ? button.outerHTML.slice(0, 300) : null,
    counter: button && button.querySelector('[data-component="ButtonCounter"]')
      ? button.querySelector('[data-component="ButtonCounter"]').textContent : null,
    pendingBadges: document.querySelectorAll('[data-testid="pending-badge"]').length,
    legacyPendingState: document.querySelector('.is-review-pending') !== null,
    legacyCount: document.querySelector('.js-pending-review-comment-count')
      ? document.querySelector('.js-pending-review-comment-count').textContent.trim() : null,
    legacyPendingComments: document.querySelectorAll('.js-pending-review-comment').length,
    embeddedComments,
    bar: host ? host.shadowRoot.querySelector('.text').textContent : null,
    title: document.title,
    icons: [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.href.slice(0, 40)),
  };
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const tab = context.pages()[0] || (await context.newPage());
  const dialogs = [];
  let answer = false;
  tab.on('dialog', async (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message().split('\n')[0]}`);
    if (answer) await dialog.accept();
    else await dialog.dismiss();
  });
  const signedInAs = () => tab.evaluate(() => {
    const meta = document.querySelector('meta[name="user-login"]');
    return meta ? meta.content : '';
  }).catch(() => '');

  await tab.goto(PR_URL);
  if (!(await signedInAs())) {
    await tab.goto(`https://github.com/login?return_to=${encodeURIComponent(new URL(PR_URL).pathname)}`);
    console.log('WAITING: sign in to GitHub in the Chrome for Testing window (up to 15 minutes).');
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!(await signedInAs())) {
      if (Date.now() > deadline) throw new Error('Not signed in after 15 minutes');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.log(`Signed in as ${await signedInAs()}`);

  const open = async (url) => {
    answer = true;
    await tab.goto(url, { waitUntil: 'load' });
    answer = false;
    await tab.waitForTimeout(3500);
    dialogs.length = 0;
  };
  const bar = () => tab.evaluate(() => {
    const host = document.getElementById('pending-review-nag');
    return host ? host.shadowRoot.querySelector('.text').textContent : null;
  });
  const seen = {};

  console.log('Detection on every PR tab');
  for (const sub of ['', '/files', '/changes', '/commits', '/checks']) {
    await test(`PR${sub || ' (Conversation)'}: bar, title prefix and warning icon`, async () => {
      await open(PR_URL + sub);
      const s = await tab.evaluate(signals);
      seen[sub || '/'] = s;
      console.log(`       ${JSON.stringify({ ...s, reviewButton: s.reviewButton ? 'yes' : null })}`);
      assert.match(s.bar || '', /pending comment/);
      assert.ok(s.title.startsWith(PREFIX));
      assert.equal(s.icons.length, 1);
      assert.match(s.icons[0], /^data:image\/svg/);
    });
  }
  fs.writeFileSync(path.join(OUT_DIR, 'signed-in-signals.json'), JSON.stringify(seen, null, 2));

  await test('store screenshot candidate (Files changed, 1280x800)', async () => {
    await open(`${PR_URL}/files`);
    await tab.screenshot({ path: path.join(OUT_DIR, 'signed-in-files.png') });
    await open(PR_URL);
    await tab.screenshot({ path: path.join(OUT_DIR, 'signed-in-conversation.png') });
  });

  console.log('Leave prompts');
  await test('Issues tab asks; Cancel stays', async () => {
    await open(PR_URL);
    await tab.locator('#pending-review-nag .text').click();
    await tab.click('a[data-tab-item="issues"], #issues-tab');
    await tab.waitForTimeout(1500);
    assert.equal(dialogs.length, 1, JSON.stringify(dialogs));
    assert.match(dialogs[0], /^confirm/);
    assert.equal(tab.url().split('?')[0].replace(/\/$/, ''), PR_URL);
  });
  await test('reload shows the native prompt', async () => {
    await open(PR_URL);
    await tab.locator('#pending-review-nag .text').click();
    await tab.reload({ timeout: 3000 }).catch(() => {});
    assert.deepEqual(dialogs.map((d) => d.split(':')[0]), ['beforeunload']);
  });

  console.log('Review dialog');
  for (const sub of ['/files', '/changes']) {
    await test(`${sub}: Finish review opens GitHub's review dialog and the bar steps aside`, async () => {
      await open(PR_URL + sub);
      await tab.locator('#pending-review-nag button.finish').click();
      await tab.waitForTimeout(1500);
      const dialog = await tab.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
        .map((d) => `aria-label=${d.getAttribute('aria-label')} aria-labelledby=${d.getAttribute('aria-labelledby')}`));
      console.log(`       dialogs on page: ${JSON.stringify(dialog)}`);
      assert.equal(await bar(), null, 'bar still shown while the review dialog is open');
      await tab.keyboard.press('Escape');
      await tab.waitForTimeout(1500);
      assert.match((await bar()) || '', /pending comment/, 'bar did not come back after closing the dialog');
    });
  }

  console.log('More interactions');
  await test('Hide: bar goes, tab title prefix and warning icon stay', async () => {
    await open(PR_URL);
    await tab.locator('#pending-review-nag button.hide').click();
    await tab.waitForTimeout(1000);
    const s = await tab.evaluate(signals);
    assert.equal(s.bar, null);
    assert.ok(s.title.startsWith(PREFIX));
    assert.match(s.icons[0], /^data:image\/svg/);
  });
  await test("GitHub's keyboard shortcut g i (go to Issues) asks", async () => {
    await open(PR_URL);
    await tab.locator('#pending-review-nag .text').click();
    await tab.keyboard.press('g');
    await tab.keyboard.press('i');
    await tab.waitForTimeout(1500);
    assert.equal(dialogs.length, 1, JSON.stringify(dialogs));
    assert.equal(tab.url().replace(/\/$/, ''), PR_URL);
  });
  await test('Back after entering the PR from the PR list (in-app) asks; Cancel keeps URL and view', async () => {
    await open(PR_URL.replace(/\/pull\/\d+$/, '/pulls'));
    await tab.evaluate(() => { window.samePageMarker = true; });
    await tab.click(`a[href$="${new URL(PR_URL).pathname}"]`);
    await tab.waitForURL(PR_URL, { timeout: 10000 });
    await tab.waitForTimeout(3000);
    assert.equal(await tab.evaluate(() => window.samePageMarker === true), true, 'not an in-app navigation');
    assert.match((await bar()) || '', /pending comment/);
    await tab.locator('#pending-review-nag .text').click();
    dialogs.length = 0;
    await tab.goBack({ timeout: 3000 }).catch(() => {});
    await tab.waitForTimeout(1500);
    assert.equal(dialogs.length, 1, JSON.stringify(dialogs));
    assert.equal(tab.url(), PR_URL);
    assert.match(await tab.title(), /Pull Request #\d+/);
  });
  await test("the tab icon Chrome itself stores for the page is the warning icon", async () => {
    await open(PR_URL);
    await tab.waitForTimeout(2000);
    const iconTab = await context.newPage();
    await iconTab.goto(`chrome://favicon2/?size=64&scaleFactor=1x&allowGoogleServerFallback=0&pageUrl=${encodeURIComponent(PR_URL)}`);
    await iconTab.screenshot({ path: path.join(OUT_DIR, 'chrome-stored-favicon.png'), clip: { x: 0, y: 0, width: 96, height: 96 } });
    // The warning icon is red; GitHub's own is black or white. Sample the stored image's pixels.
    const red = await iconTab.evaluate(() => {
      const img = document.querySelector('img');
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let reddish = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) reddish++;
      return { reddish, pixels: d.length / 4, size: `${img.naturalWidth}x${img.naturalHeight}` };
    });
    await iconTab.close();
    console.log(`       stored icon ${red.size}: ${red.reddish} red pixels of ${red.pixels}`);
    assert.ok(red.reddish > red.pixels * 0.2, 'stored favicon is not the red warning icon');
  });
  await test('speed: one detection pass on a large signed-in PR (/changes) at 6x CPU throttle', async () => {
    const big = process.env.BIG_PR_URL || 'https://github.com/nodejs/node/pull/50000/changes';
    await open(big);
    const cdp = await context.newCDPSession(tab);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const result = await tab.evaluate(() => {
      const selectors = [
        'button[class*="ReviewMenuButton"]', '[data-testid="pending-badge"]', '.is-review-pending',
        '.js-pending-review-comment-count', '.js-pending-review-comment',
        'react-app[app-name="repo"] script[data-target="react-app.embeddedData"]',
        '[role="dialog"][aria-label="Review changes"], [role="dialog"][aria-labelledby="anchored-review-title"]',
      ];
      const start = performance.now();
      for (let i = 0; i < 20; i++) for (const s of selectors) document.querySelectorAll(s).length;
      return { ms: (performance.now() - start) / 20, elements: document.getElementsByTagName('*').length };
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    console.log(`       ${big}: ${result.elements} elements, ${result.ms.toFixed(2)} ms per pass (runs at most every 300 ms)`);
    assert.ok(result.ms < 16, 'a pass should fit in one frame even at 6x throttle');
  });

  // Ending a review needs a write on GitHub, so these run only when asked, on your own test PR.
  const dialogButtons = () => tab.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, [role="menu"] [role="menuitem"]')]
    .map((b) => (b.getAttribute('aria-label') || b.textContent).trim()).filter(Boolean));
  if (process.env.SUBMIT) {
    console.log('Submit');
    await test('submitting the review clears bar, title and icon, with no "Leave site?"', async () => {
      await open(`${PR_URL}/changes`);
      await tab.locator('#pending-review-nag .text').click();
      await tab.locator('#pending-review-nag button.finish').click();
      await tab.waitForTimeout(1500);
      console.log(`       review dialog buttons: ${JSON.stringify(await dialogButtons())}`);
      await tab.locator('[role="dialog"] textarea').first().fill('Submitted by the extension check.').catch(() => {});
      await tab.locator('[role="dialog"] button:has-text("Submit review")').first().click();
      await tab.waitForTimeout(6000);
      const s = await tab.evaluate(signals);
      console.log(`       after submit: ${JSON.stringify({ ...s, reviewButton: s.reviewButton ? 'yes' : null })}; dialogs ${JSON.stringify(dialogs)}`);
      assert.deepEqual(dialogs, []);
      assert.equal(s.bar, null);
      assert.ok(!s.title.includes(PREFIX));
      assert.ok(!s.icons.some((href) => href.startsWith('data:')));
    });
  }
  if (process.env.NEW_PENDING_CMD) {
    // A shell command (e.g. gh api ...) that starts a fresh pending review, so discarding can be checked too.
    require('node:child_process').execSync(process.env.NEW_PENDING_CMD, { stdio: 'inherit' });
    console.log('Discard');
    await test('discarding the review clears bar, title and icon, with no "Leave site?"', async () => {
      await open(`${PR_URL}/changes`);
      assert.match((await bar()) || '', /pending comment/, 'no bar for the new pending review');
      await tab.locator('#pending-review-nag .text').click();
      await tab.locator('#pending-review-nag button.finish').click();
      await tab.waitForTimeout(1500);
      let buttons = await dialogButtons();
      console.log(`       review dialog buttons: ${JSON.stringify(buttons)}`);
      let discard = tab.locator('[role="dialog"] button:has-text("Discard"), [role="menu"] [role="menuitem"]:has-text("Discard")').first();
      if (!(await discard.count())) {
        // The discard action may sit behind a "more options" button in the dialog.
        const more = tab.locator('[role="dialog"] button[aria-haspopup="true"], [role="dialog"] button[aria-label*="more" i]').first();
        if (await more.count()) await more.click();
        await tab.waitForTimeout(800);
        buttons = await dialogButtons();
        console.log(`       after opening its menu: ${JSON.stringify(buttons)}`);
        discard = tab.locator('[role="menu"] [role="menuitem"]:has-text("Discard"), [role="dialog"] button:has-text("Discard")').first();
      }
      answer = true; // GitHub may confirm the discard with its own question
      await discard.click();
      await tab.waitForTimeout(1500);
      // A second, GitHub-made confirmation dialog, if any.
      const confirmButton = tab.locator('[role="alertdialog"] button:has-text("Discard"), [role="dialog"] button:has-text("Discard review")').last();
      if (await confirmButton.count()) await confirmButton.click();
      await tab.waitForTimeout(6000);
      answer = false;
      const s = await tab.evaluate(signals);
      console.log(`       after discard: ${JSON.stringify({ ...s, reviewButton: s.reviewButton ? 'yes' : null })}; dialogs ${JSON.stringify(dialogs)}`);
      assert.ok(!dialogs.some((d) => d.startsWith('beforeunload')), JSON.stringify(dialogs));
      assert.equal(s.bar, null);
      assert.ok(!s.title.includes(PREFIX));
      assert.ok(!s.icons.some((href) => href.startsWith('data:')));
    });
  }

  await context.close();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
