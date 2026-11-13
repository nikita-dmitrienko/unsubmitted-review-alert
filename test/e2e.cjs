// End-to-end test: loads the real unpacked extension in Chrome for Testing and serves
// fixture pages at https://github.com/* through request routing. No network, no GitHub account.
// Fixture markup follows GitHub's shipped code; test/signed-in.cjs checks the same signals on a real pending review.
// Run: npm test   (or NODE_PATH=<dir containing playwright> node test/e2e.cjs)
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { barContrast, assertReadable } = require('./contrast.cjs');

// EXTENSION_DIR can point at an unzipped dist/*.zip to test the exact upload.
const EXTENSION_DIR = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '../extension'));
const PREFIX = '⚠ PENDING REVIEW · ';
const APPROVAL_WINDOW_MS = 4000;

// A stand-in for GitHub's in-app router: a bubble-phase click handler that announces a Turbo visit
// (cancelable) and then soft-navigates with pushState and a body swap, firing no load event.
const ROUTER_SCRIPT = `<script>
  window.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[data-router]');
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    window.routedClicks = (window.routedClicks || 0) + 1;
    const visit = new CustomEvent('turbo:before-visit', { bubbles: true, cancelable: true, detail: { url: link.href } });
    if (!document.documentElement.dispatchEvent(visit)) return;
    history.pushState({}, '', link.getAttribute('href'));
    document.title = link.dataset.title || 'Routed';
    document.body.innerHTML = link.dataset.body || '<h1>Routed</h1>';
  });
</script>`;

function page(body, { title = 'Fixture PR' } = {}) {
  return `<!doctype html><html><head><title>${title}</title>
    <link rel="alternate icon" class="js-site-favicon" type="image/png" href="https://github.githubassets.com/favicons/favicon.png">
    <link rel="icon" class="js-site-favicon" type="image/svg+xml" href="https://github.githubassets.com/favicons/favicon.svg">
    ${ROUTER_SCRIPT}</head><body>${body}
    <p><a id="same-pr" href="/octo/repo/pull/1/commits">Commits (same PR, full load)</a></p>
    <p><a id="same-pr-routed" data-router href="/octo/repo/pull/1/checks">Checks (same PR, routed)</a></p>
    <p><a id="other-pr" href="/octo/repo/pull/2">Another PR</a></p>
    <p><a id="other-pr-routed" data-router href="/octo/repo/pull/2">Another PR (routed)</a></p>
    <p><a id="issues-routed" data-router data-title="Issues" href="/octo/repo/issues">Issues (routed)</a></p>
    <p><a id="full-nav" data-turbo="false" href="/octo/repo/issues">Issues (full page load)</a></p>
    <p><a id="new-tab" target="_blank" href="/octo/repo/pull/2">Another PR in a new tab</a></p>
    <p><a id="other-site" href="https://example.org/">Another website</a></p>
  </body></html>`;
}

const reactButton = (count) =>
  `<button class="prc-Button-ButtonBase-x ReviewMenuButton__9e8CKv"><span>Submit review</span>${
    count ? `<span data-component="ButtonCounter">${count}</span>` : ''
  }</button>`;

// GitHub's CommentHeaderBadge puts both attributes on one element.
const pendingBadge = '<span data-testid="pending-badge" aria-label="This review comment is pending">Pending</span>';

const embedded = (initialPath, review) =>
  `<react-app app-name="repo" initial-path="${initialPath}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
    { payload: { pullRequestsLayoutRoute: { viewerPendingReview: review } } },
  )}</script></react-app>`;

// GitHub's review box as its signed-in code behaves (bundle read 2026-11-13): Discard asks a native confirm();
// on OK the button gets data-loading="true" and a DELETE runs; on success the Overview box just closes and
// GitHub leaves its own counter and "Pending" badges stale; on failure the box stays open with an error.
const DISCARD_SCRIPT = `<script>
  window.openReviewDialog = (outcome) => {
    document.body.insertAdjacentHTML('beforeend', '<div id="review-dialog" role="dialog" aria-labelledby="anchored-review-title">' +
      '<h1 id="anchored-review-title">Finish your review</h1>' +
      '<button id="discard" type="button" data-dd-action-name="pull_requests.review.discard" data-loading="false"><span>Discard review</span></button>' +
      '<button id="close-dialog" type="button" data-dd-action-name="pull_requests.review.cancel">Cancel</button></div>');
    const discard = document.getElementById('discard');
    discard.addEventListener('click', () => {
      if (!confirm('Are you sure you want to cancel? You will lose all your pending comments.')) return;
      discard.setAttribute('data-loading', 'true');
      discard.disabled = true;
      discard.firstChild.textContent = 'Discarding';
      setTimeout(() => {
        if (outcome === 'error') {
          discard.setAttribute('data-loading', 'false');
          discard.disabled = false;
          discard.firstChild.textContent = 'Discard review';
          discard.insertAdjacentHTML('beforebegin', '<p class="flash-error">Failed to submit review</p>');
          return;
        }
        document.getElementById('review-dialog').remove();
      }, window.discardDelay === undefined ? 150 : window.discardDelay);
    });
    document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('review-dialog').remove());
  };
</script>`;

const FIXTURES = {
  '/octo/repo/pull/1': page(reactButton(2)),
  '/octo/repo/pull/1/commits': page(reactButton(2), { title: 'Commits' }),
  '/octo/repo/pull/2': page('<h1>Other PR, nothing pending</h1>'),
  '/octo/repo/pull/3': page(pendingBadge.repeat(2)),
  '/octo/repo/pull/4/files': page(
    '<div class="js-review-state-classes is-review-pending"><div class="pr-review-tools"><button class="js-reviews-toggle">Review changes <span class="Counter js-pending-review-comment-count">3</span></button></div></div>',
  ),
  '/octo/repo/pull/5': page(embedded('/octo/repo/pull/5', { id: 'PRR_1', comments: [{}, {}] })),
  '/octo/repo/pull/6': page(embedded('/octo/repo/pull/6', { id: 'PRR_1', comments: [{}] }) + reactButton(0)),
  '/octo/repo/pull/7': page(embedded('/octo/repo/pull/99', { id: 'PRR_1', comments: [{}] })),
  '/octo/repo/pull/8': page('<h1>Nothing pending</h1>'),
  '/octo/repo/pull/9': page(embedded('/octo/repo/pull/9', { id: 'PRR_1', comments: [] })),
  '/octo/repo/pull/10': page('<span class="Label">Pending</span><h2>Finish your review</h2>'),
  '/octo/repo/pull/11/conflicts': page(reactButton(2)),
  '/octo/repo/pull/12': page('<form id="submit-review" method="post" action="/octo/repo/pull/12/reviews"><button>Submit review</button></form>' + reactButton(1)),
  '/octo/repo/pull/14/changes': page(embedded('/octo/repo/pull/14/changes', { id: 'PRR_1', comments: [{}, {}] }) + reactButton(2)),
  '/octo/repo/pull/15': page(embedded('/octo/repo/pull/15', { id: 'PRR_1', comments: [{}, {}] }) + pendingBadge.repeat(2)),
  '/octo/repo/pull/16': page(reactButton(2) + pendingBadge.repeat(2) + DISCARD_SCRIPT),
  '/octo/repo/pulls': page(`<a id="soft" data-router data-title="Fixture PR" data-body='${reactButton(4)}' href="/octo/repo/pull/1">PR 1</a>`, { title: 'Pull requests' }),
  '/octo/repo/issues': page('<h1>Issues</h1>', { title: 'Issues' }),
};

async function bannerText(tab) {
  return tab.evaluate(() => {
    const host = document.getElementById('pending-review-nag');
    return host ? host.shadowRoot.textContent : null;
  });
}

async function waitForState(tab, wantBanner) {
  await tab.waitForFunction(
    (want) => (document.getElementById('pending-review-nag') !== null) === want,
    wantBanner,
    { timeout: 3000 },
  );
}

// Starts a review on the current page (adds a counter), proving the extension is alive and observing.
async function startReviewInPage(tab) {
  await tab.evaluate(() => {
    const counter = '<span data-component="ButtonCounter">1</span>';
    const button = document.querySelector('button[class*="ReviewMenuButton"]');
    if (button) button.insertAdjacentHTML('beforeend', counter);
    else document.body.insertAdjacentHTML('beforeend', `<button class="ReviewMenuButton__x">${counter}</button>`);
  });
  await waitForState(tab, true);
}

// The fake router swaps the body; put a plain link to another PR back on the routed page.
async function addOtherPrLink(tab) {
  await tab.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<a id="other-pr" href="/octo/repo/pull/2">Another PR</a>'));
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n')[0]}`);
  }
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    // Optional override when Playwright's expected browser build is not downloaded.
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  await context.route('https://github.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const body = FIXTURES[pathname];
    if (body) return route.fulfill({ status: 200, contentType: 'text/html', body });
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 302, headers: { location: '/octo/repo/pull/12' } });
    }
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<title>Not found</title>not found' });
  });
  await context.route('https://example.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Example</title>elsewhere' }));

  const tab = await context.newPage();
  const dialogs = [];
  let dialogAnswer = false;
  tab.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    if (dialogAnswer) await dialog.accept();
    else await dialog.dismiss();
  });
  // Accepts the extension's own leave prompt from the previous fixture, then starts a clean dialog log.
  const open = async (pathname) => {
    dialogAnswer = true;
    await tab.goto(`https://github.com${pathname}`);
    dialogAnswer = false;
    dialogs.length = 0;
  };
  const pathnameNow = () => new URL(tab.url()).pathname;

  console.log('Detection');
  await test('React review button counter shows banner, count and title prefix', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /2 pending comments/);
    assert.ok((await tab.title()).startsWith(PREFIX));
  });
  await test('pending badges alone are detected and counted once each', async () => {
    await open('/octo/repo/pull/3');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /2 pending comments/);
  });
  await test('classic Files view .is-review-pending with counter', async () => {
    await open('/octo/repo/pull/4/files');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /3 pending comments/);
  });
  await test('embedded viewerPendingReview on first load', async () => {
    await open('/octo/repo/pull/5');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /2 pending comments/);
  });
  for (const [pathname, why, isPrPage] of [
    ['/octo/repo/pull/6', 'live button without counter overrides stale embedded data', true],
    ['/octo/repo/pull/7', 'embedded data for a different PR is ignored', true],
    ['/octo/repo/pull/8', 'nothing pending', true],
    ['/octo/repo/pull/9', 'pending review with zero comments', true],
    ['/octo/repo/pull/10', 'bare "Pending" / "Finish your review" text', true],
    ['/octo/repo/pull/11/conflicts', 'conflicts page is not a PR page', false],
    ['/octo/repo/issues', 'non-PR page', false],
  ]) {
    await test(`no banner: ${why}`, async () => {
      await open(pathname);
      await tab.waitForTimeout(800);
      assert.equal(await bannerText(tab), null);
      assert.ok(!(await tab.title()).includes(PREFIX));
      // Positive control on the same page: a crashed or unobserved check would fail here.
      if (isPrPage) await startReviewInPage(tab);
    });
  }

  console.log('Live updates');
  await test('submitting (counter disappears) removes banner and title prefix', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => document.querySelector('[data-component="ButtonCounter"]').remove());
    await waitForState(tab, false);
    assert.ok(!(await tab.title()).includes(PREFIX));
  });
  await test('counter text updated in place updates the banner count', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => { document.querySelector('[data-component="ButtonCounter"]').firstChild.nodeValue = '5'; });
    await tab.waitForFunction(() => /5 pending comments/.test(document.getElementById('pending-review-nag').shadowRoot.textContent), null, { timeout: 3000 });
  });
  await test('soft navigation (pushState only, no load event) from a PR list into a pending PR', async () => {
    await open('/octo/repo/pulls');
    await tab.waitForTimeout(500);
    await tab.click('#soft');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /4 pending comments/);
  });
  await test('soft navigation to a PR tab without any signal keeps the nag', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#same-pr-routed');
    await tab.waitForURL('**/pull/1/checks');
    await tab.waitForTimeout(800);
    assert.match(await bannerText(tab), /2 pending comments/);
    await addOtherPrLink(tab);
    await tab.click('#other-pr');
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
  });
  await test('embedded snapshot carries over to another tab of the same PR', async () => {
    await open('/octo/repo/pull/5');
    await waitForState(tab, true);
    await tab.evaluate(() => { history.pushState({}, '', '/octo/repo/pull/5/commits'); document.body.innerHTML = '<h1>Commits</h1>'; });
    await tab.waitForTimeout(800);
    assert.match(await bannerText(tab), /2 pending comments/);
  });
  await test('after the counter clears, stale embedded data does not bring the nag back', async () => {
    await open('/octo/repo/pull/14/changes');
    await waitForState(tab, true);
    await tab.evaluate(() => document.querySelector('[data-component="ButtonCounter"]').remove());
    await waitForState(tab, false);
    await tab.evaluate(() => {
      history.pushState({}, '', '/octo/repo/pull/14/changes');
      document.querySelector('button[class*="ReviewMenuButton"]').remove();
    });
    await tab.waitForTimeout(800);
    assert.equal(await bannerText(tab), null);
  });
  await test('deleting pending comments in place drops the page-load snapshot', async () => {
    await open('/octo/repo/pull/15');
    await waitForState(tab, true);
    await tab.evaluate(() => document.querySelectorAll('[data-testid="pending-badge"]').forEach((badge) => badge.remove()));
    await waitForState(tab, false);
  });
  await test('soft navigation away from a pending PR clears banner and guards', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    dialogAnswer = true;
    await tab.click('#issues-routed');
    await waitForState(tab, false);
    dialogAnswer = false;
    assert.deepEqual(dialogs, ['confirm']);
    assert.ok(!(await tab.title()).includes(PREFIX));
    await tab.waitForTimeout(APPROVAL_WINDOW_MS + 200);
    await tab.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<a id="later" data-router href="/octo/repo/pull/2">x</a>'));
    await tab.click('#later');
    await tab.waitForURL('**/pull/2');
    assert.deepEqual(dialogs, ['confirm']);
  });
  await test('title prefix survives GitHub and other extensions rewriting the title', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => { document.title = 'Renamed by GitHub'; });
    await tab.waitForFunction((p) => document.title === p + 'Renamed by GitHub', PREFIX, { timeout: 3000 });
    await tab.evaluate(() => { document.title = '✏️ Comment - ' + document.title; });
    await tab.waitForTimeout(800);
    assert.equal(await tab.title(), PREFIX + '✏️ Comment - Renamed by GitHub');
  });
  await test('Hide banner keeps the title prefix', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.locator('#pending-review-nag').locator('button.hide').click();
    await waitForState(tab, false);
    await tab.waitForTimeout(800);
    assert.equal(await bannerText(tab), null);
    assert.ok((await tab.title()).startsWith(PREFIX));
  });
  await test('warning favicon replaces GitHub icons while pending; theirs come back after submit', async () => {
    const icons = () => tab.evaluate(() => [...document.querySelectorAll('link[rel~="icon"]')].map((l) => `${l.getAttribute('rel')} ${l.href.slice(0, 60)}`));
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const pendingIcons = await icons();
    assert.equal(pendingIcons.length, 1);
    assert.match(pendingIcons[0], /^icon data:image\/svg\+xml/);
    await tab.evaluate(() => document.querySelector('[data-component="ButtonCounter"]').remove());
    await waitForState(tab, false);
    await tab.waitForTimeout(400);
    assert.deepEqual(await icons(), [
      'alternate icon https://github.githubassets.com/favicons/favicon.png',
      'icon https://github.githubassets.com/favicons/favicon.svg',
    ]);
  });
  await test('icons GitHub adds later while pending are parked too', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => document.head.insertAdjacentHTML('beforeend', '<link rel="icon" href="https://github.githubassets.com/favicons/favicon-pending.svg">'));
    await tab.waitForFunction(() => document.querySelectorAll('link[rel~="icon"]').length === 1, null, { timeout: 3000 });
  });
  await test('page reserves room under the bar, so nothing at the bottom is covered', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const sizes = await tab.evaluate(() => {
      const host = document.getElementById('pending-review-nag');
      return { host: host.getBoundingClientRect().height, bar: host.shadowRoot.querySelector('.bar').offsetHeight };
    });
    assert.ok(sizes.bar > 20, `bar height ${sizes.bar}`);
    assert.equal(sizes.host, sizes.bar);
  });
  await test('banner steps aside while GitHub review dialog is open', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="dlg" role="dialog" aria-labelledby="anchored-review-title"><button>Submit review</button></div>'));
    await waitForState(tab, false);
    await tab.evaluate(() => document.getElementById('dlg').remove());
    await waitForState(tab, true);
  });
  await test('Finish review clicks GitHub review button', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => document.querySelector('button[class*="ReviewMenuButton"]').addEventListener('click', () => { window.reviewOpened = true; }));
    await tab.locator('#pending-review-nag').locator('button.finish').click();
    assert.equal(await tab.evaluate(() => window.reviewOpened), true);
  });
  await test('Finish review without a review button opens Files with no leave prompt', async () => {
    await open('/octo/repo/pull/5');
    await waitForState(tab, true);
    await tab.locator('#pending-review-nag').locator('button.finish').click();
    await tab.waitForURL('**/octo/repo/pull/5/files', { timeout: 3000 });
    assert.deepEqual(dialogs, []);
  });

  console.log('Theme and accessibility');
  const PRIMER_DARK = `<style>:root { --bgColor-default:#0d1117; --bgColor-danger-muted:#f851491a; --bgColor-danger-emphasis:#da3633;
    --fgColor-default:#f0f6fc; --fgColor-muted:#9198a1; --fgColor-danger:#f85149; --fgColor-onEmphasis:#fff;
    --borderColor-default:#3d444d; --borderColor-danger-emphasis:#da3633; --button-default-bgColor-rest:#212830;
    --button-default-borderColor-rest:#3d444d; --button-default-fgColor-rest:#f0f6fc; --focus-outlineColor:#1f6feb; }</style>`;
  await test('light system theme, no GitHub variables: light bar, readable (WCAG AA)', async () => {
    await tab.emulateMedia({ colorScheme: 'light' });
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const c = await tab.evaluate(barContrast);
    assert.equal(c.background, 'rgb(255, 235, 233)');
    assertReadable(assert, c, 'light fallback');
  });
  await test('dark system theme, no GitHub variables: dark bar, readable', async () => {
    await tab.emulateMedia({ colorScheme: 'dark' });
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const c = await tab.evaluate(barContrast);
    assert.equal(c.background, 'rgb(37, 23, 28)');
    assertReadable(assert, c, 'dark fallback');
    await tab.emulateMedia({ colorScheme: 'light' });
  });
  await test("GitHub's theme variables win over the system setting (dark GitHub on a light OS)", async () => {
    await tab.emulateMedia({ colorScheme: 'light' });
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate((css) => document.head.insertAdjacentHTML('beforeend', css), PRIMER_DARK);
    const c = await tab.evaluate(barContrast);
    assert.equal(c.background, 'rgb(37, 23, 28)');
    assertReadable(assert, c, 'Primer dark');
  });
  await test('Windows contrast themes (forced colors): the bar keeps a visible edge', async () => {
    await tab.emulateMedia({ forcedColors: 'active' });
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const edge = await tab.evaluate(() =>
      getComputedStyle(document.getElementById('pending-review-nag').shadowRoot.querySelector('.bar')).borderTopWidth);
    await tab.emulateMedia({ forcedColors: 'none' });
    assert.equal(edge, '2px');
  });
  await test("Chrome's accessibility tree: named region, named buttons, polite status", async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.waitForTimeout(800);
    const cdp = await context.newCDPSession(tab);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    await cdp.detach();
    const named = (role) => nodes.filter((n) => !n.ignored && n.role && n.role.value === role).map((n) => n.name && n.name.value);
    assert.ok(named('region').includes('Unsubmitted review'), JSON.stringify(named('region')));
    assert.ok(named('button').includes('Finish review'));
    assert.ok(named('button').includes('Hide review reminder'));
    const status = nodes.find((n) => !n.ignored && n.role && n.role.value === 'status');
    assert.ok(status, 'no status node');
    const live = (status.properties || []).find((p) => p.name === 'live');
    assert.equal(live && live.value.value, 'polite');
    // The warning glyph is decorative and must not be read out.
    assert.ok(!nodes.some((n) => !n.ignored && n.name && n.name.value === '⚠'));
  });
  await test('screen reader message: filled after the bar appears, updated when the count changes', async () => {
    await open('/octo/repo/pull/1');
    const announce = () => tab.evaluate(() => {
      const host = document.getElementById('pending-review-nag');
      return host ? host.shadowRoot.querySelector('.announce').textContent : null;
    });
    await waitForState(tab, true);
    assert.equal(await announce(), '', 'a live region filled while inserted is not reliably announced');
    await tab.waitForFunction(() => document.getElementById('pending-review-nag').shadowRoot.querySelector('.announce').textContent !== '', null, { timeout: 2000 });
    assert.equal(await announce(), 'Review not submitted: 2 pending comments, visible only to you until you submit.');
    await tab.evaluate(() => { document.querySelector('[data-component="ButtonCounter"]').firstChild.nodeValue = '3'; });
    await tab.waitForFunction(() => /3 pending comments/.test(document.getElementById('pending-review-nag').shadowRoot.querySelector('.announce').textContent), null, { timeout: 2000 });
  });
  await test('keyboard: Shift+Tab from the top reaches Hide, then Finish review; focus ring shows; Enter works', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const focused = () => tab.evaluate(() => {
      const inner = document.activeElement && document.activeElement.shadowRoot && document.activeElement.shadowRoot.activeElement;
      return inner ? { cls: inner.className, outline: getComputedStyle(inner).outlineStyle } : null;
    });
    await tab.evaluate(() => { window.reviewOpened = false; document.querySelector('button[class*="ReviewMenuButton"]').addEventListener('click', () => { window.reviewOpened = true; }); });
    await tab.focus('body');
    await tab.keyboard.press('Shift+Tab');
    assert.deepEqual(await focused(), { cls: 'hide', outline: 'solid' });
    await tab.keyboard.press('Shift+Tab');
    assert.deepEqual(await focused(), { cls: 'finish', outline: 'solid' });
    await tab.keyboard.press('Enter');
    assert.equal(await tab.evaluate(() => window.reviewOpened), true);
  });

  console.log('Leave guards');
  await test('link to another PR asks; Cancel stays and blocks the page router', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#other-pr-routed');
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
    assert.equal(await tab.evaluate(() => window.routedClicks || 0), 0);
  });
  await test('accepting the confirm on a routed (Turbo) link asks once', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    dialogAnswer = true;
    await tab.click('#other-pr-routed');
    await tab.waitForURL('**/pull/2');
    dialogAnswer = false;
    assert.deepEqual(dialogs, ['confirm']);
  });
  await test('accepting the confirm on a full-page link does not ask twice', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    dialogAnswer = true;
    await tab.click('#full-nav');
    await tab.waitForURL('**/octo/repo/issues');
    dialogAnswer = false;
    assert.deepEqual(dialogs, ['confirm']);
  });
  await test('full-page link within the same PR does not ask', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#same-pr');
    await tab.waitForURL('**/pull/1/commits');
    assert.deepEqual(dialogs, []);
  });
  await test('a same-PR link does not open a window for leaving unasked', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#same-pr-routed');
    await tab.waitForURL('**/pull/1/checks');
    await addOtherPrLink(tab);
    await tab.click('#other-pr');
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1/checks');
    await tab.reload({ timeout: 1500 }).catch(() => {});
    assert.deepEqual(dialogs, ['confirm', 'beforeunload']);
  });
  await test('target=_blank link does not ask', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const popup = context.waitForEvent('page');
    await tab.click('#new-tab');
    await (await popup).close();
    assert.deepEqual(dialogs, []);
  });
  await test('reload after interacting shows the native leave prompt', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    await tab.reload({ timeout: 1500 }).catch(() => {});
    assert.deepEqual(dialogs, ['beforeunload']);
  });
  await test('turbo:before-visit to another PR asks and is cancelled', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    const notCancelled = await tab.evaluate(() =>
      document.documentElement.dispatchEvent(
        new CustomEvent('turbo:before-visit', { bubbles: true, cancelable: true, detail: { url: 'https://github.com/octo/repo/pull/2' } }),
      ),
    );
    assert.equal(notCancelled, false);
    assert.deepEqual(dialogs, ['confirm']);
  });
  await test("GitHub's post-submit redirect to the same PR (no click) does not prompt", async () => {
    await open('/octo/repo/pull/1/commits');
    await waitForState(tab, true);
    await Promise.all([tab.waitForURL('**/octo/repo/pull/1'), tab.evaluate(() => { location.href = '/octo/repo/pull/1'; })]);
    assert.deepEqual(dialogs, []);
  });
  await test('a script navigation to another PR still prompts', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => { location.href = '/octo/repo/pull/2'; });
    await tab.waitForTimeout(500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
  });
  await test('submitting the review form does not trigger the leave prompt', async () => {
    await open('/octo/repo/pull/12');
    await waitForState(tab, true);
    await Promise.all([tab.waitForEvent('load'), tab.click('#submit-review button')]);
    assert.deepEqual(dialogs, []);
  });
  await test('closing the tab shows the native leave prompt; Cancel keeps the tab', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    await tab.close({ runBeforeUnload: true });
    await tab.waitForTimeout(500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(tab.isClosed(), false);
  });
  await test('typing another address in the address bar shows the native leave prompt', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    await tab.goto('https://example.org/', { timeout: 1500 }).catch(() => {});
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
    await tab.waitForTimeout(500); // let the cancelled navigation settle before the next test loads a page
  });
  await test('a link to another website: no in-page question, the native prompt instead (asked once)', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#other-site');
    await tab.waitForTimeout(500);
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(new URL(tab.url()).host, 'github.com');
  });
  await test('keyboard: Enter on a focused link to another PR asks', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.focus('#other-pr');
    await tab.keyboard.press('Enter');
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
  });
  await test('a script click (GitHub keyboard shortcuts click links) asks too', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.evaluate(() => document.getElementById('issues-routed').click());
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
  });
  await test('Cmd/Ctrl-click and middle-click open a new tab without asking', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    for (const options of [{ modifiers: ['ControlOrMeta'] }, { button: 'middle' }]) {
      const popup = context.waitForEvent('page', { timeout: 3000 });
      await tab.click('#other-pr', options);
      await (await popup).close();
    }
    assert.deepEqual(dialogs, []);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
  });
  await test('Back button to the previous page shows the native leave prompt', async () => {
    await open('/octo/repo/issues');
    await tab.click('#other-pr'); // full page load into a PR, then start a review there
    await tab.waitForURL('**/pull/2');
    await startReviewInPage(tab);
    await tab.mouse.click(5, 5);
    await tab.goBack({ timeout: 1500 }).catch(() => {});
    assert.deepEqual(dialogs, ['beforeunload']);
    assert.equal(pathnameNow(), '/octo/repo/pull/2');
  });
  await test('Back inside the app (no page load) to a non-PR page asks; Cancel stays', async () => {
    await open('/octo/repo/pulls');
    await tab.waitForTimeout(500);
    await tab.click('#soft'); // in-app navigation into a pending PR
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    dialogs.length = 0;
    await tab.goBack({ timeout: 1500 }).catch(() => {});
    await tab.waitForTimeout(300);
    assert.deepEqual(dialogs, ['confirm']);
    assert.equal(pathnameNow(), '/octo/repo/pull/1');
    assert.equal(await bannerText(tab) !== null, true);
  });
  await test('Back inside the app: OK leaves once and clears the nag', async () => {
    await open('/octo/repo/pulls');
    await tab.waitForTimeout(500);
    await tab.click('#soft');
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    dialogs.length = 0;
    dialogAnswer = true;
    await tab.goBack({ timeout: 1500 }).catch(() => {});
    await tab.waitForURL('**/octo/repo/pulls');
    dialogAnswer = false;
    assert.deepEqual(dialogs, ['confirm']);
    await tab.waitForFunction((p) => !document.title.includes(p), PREFIX, { timeout: 3000 });
  });
  await test('Back inside the same PR (tab to tab) does not ask', async () => {
    await open('/octo/repo/pull/1');
    await waitForState(tab, true);
    await tab.click('#same-pr-routed');
    await tab.waitForURL('**/pull/1/checks');
    await tab.mouse.click(5, 5);
    await tab.goBack({ timeout: 1500 }).catch(() => {});
    await tab.waitForURL('**/pull/1');
    assert.deepEqual(dialogs, []);
  });
  console.log('Discarding a review');
  const openDialogAndDiscard = async (outcome, answer, delay) => {
    await open('/octo/repo/pull/16');
    await waitForState(tab, true);
    await tab.mouse.click(5, 5);
    await tab.evaluate(([o, d]) => { if (d !== undefined) window.discardDelay = d; window.openReviewDialog(o); }, [outcome, delay]);
    await waitForState(tab, false); // the bar steps aside while the box is open
    dialogAnswer = answer;
    await tab.click('#discard');
    await tab.waitForTimeout(600);
    dialogAnswer = false;
  };
  await test('discard on Overview: GitHub leaves its counter stale, the nag clears anyway', async () => {
    await openDialogAndDiscard('success', true);
    await tab.waitForTimeout(800);
    assert.equal(await bannerText(tab), null);
    assert.ok(!(await tab.title()).includes(PREFIX));
    assert.equal(await tab.evaluate(() => document.querySelector('[data-component="ButtonCounter"]').textContent), '2', 'fixture must keep the stale counter');
    await tab.reload({ timeout: 1500 }).catch(() => {});
    assert.deepEqual(dialogs, ['confirm'], 'no "Leave site?" after a discard');
  });
  await test('discard that finishes before the next check (instant response) also clears', async () => {
    await openDialogAndDiscard('success', true, 0);
    await tab.waitForTimeout(800);
    assert.equal(await bannerText(tab), null);
  });
  await test("Cancel in GitHub's discard question keeps the nag after the box closes", async () => {
    await openDialogAndDiscard('success', false);
    assert.deepEqual(dialogs, ['confirm']);
    await tab.click('#close-dialog');
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /2 pending comments/);
  });
  await test('Cancel in the discard question, then closing the box at once, keeps the nag', async () => {
    await open('/octo/repo/pull/16');
    await waitForState(tab, true);
    await tab.evaluate(() => window.openReviewDialog('success'));
    await waitForState(tab, false);
    dialogAnswer = false;
    // Both clicks in one task: the box is gone before the extension's next check runs.
    await tab.evaluate(() => { document.getElementById('discard').click(); document.getElementById('close-dialog').click(); });
    await waitForState(tab, true);
    await tab.waitForTimeout(800);
    assert.match(await bannerText(tab), /2 pending comments/);
  });
  await test('a failed discard keeps the nag after the box closes', async () => {
    await openDialogAndDiscard('error', true);
    await tab.click('#close-dialog');
    await waitForState(tab, true);
    assert.ok((await tab.title()).startsWith(PREFIX));
  });
  await test('after a discard, a new pending comment brings the nag back', async () => {
    await openDialogAndDiscard('success', true);
    await tab.waitForTimeout(800);
    assert.equal(await bannerText(tab), null);
    await tab.evaluate(() => { document.querySelector('[data-component="ButtonCounter"]').firstChild.nodeValue = '3'; });
    await waitForState(tab, true);
    assert.match(await bannerText(tab), /3 pending comments/);
  });
  await test('no guards when nothing is pending', async () => {
    await open('/octo/repo/pull/8');
    await tab.waitForTimeout(800);
    await tab.mouse.click(5, 5);
    await tab.click('#other-pr');
    await tab.waitForURL('**/pull/2');
    assert.deepEqual(dialogs, []);
  });

  await context.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
