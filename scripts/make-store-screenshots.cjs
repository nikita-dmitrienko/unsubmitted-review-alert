// Real store screenshots and a demo GIF, taken signed in on a PR where your account has a pending review.
// Opens Chrome for Testing with the extension; sign in to GitHub in that window, the rest runs by itself.
// Writes raw 1280x800 shots, captioned store versions, a 1400x560 marquee and demo.gif to OUT_DIR.
// Needs ffmpeg for the GIF. PROFILE_DIR keeps your GitHub session: delete it afterwards.
// Run: PR_URL=https://github.com/<you>/<repo>/pull/<n> PROFILE_DIR=<dir> OUT_DIR=store/assets/screenshots node scripts/make-store-screenshots.cjs
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const { PR_URL, PROFILE_DIR } = process.env;
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'store/assets/screenshots'));
if (!PR_URL || !PROFILE_DIR) throw new Error('Set PR_URL and PROFILE_DIR');
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = (name) => path.join(OUT_DIR, name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CAPTIONS = [
  ['1-files-light.png', 'Started a review and forgot to submit it? You will know.'],
  ['2-files-dark.png', 'Follows your GitHub theme, light or dark'],
  ['3-overview.png', 'Reminds you on every tab of the pull request'],
  ['4-closeup.png', 'Counts your pending comments, which nobody else can see yet'],
  ['5-review-box.png', 'One click opens GitHub’s review box to finish'],
];

(async () => {
  const videoDir = path.join(OUT_DIR, '.video');
  fs.rmSync(videoDir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
    headless: false,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2, // sharp close-ups; normal shots are saved at CSS size (1280x800)
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const tab = context.pages()[0] || (await context.newPage());
  // The extension rightly asks before the script moves between pages; always answer "leave".
  context.on('page', (page) => page.on('dialog', (dialog) => dialog.accept()));
  tab.on('dialog', (dialog) => dialog.accept());
  const login = () => tab.evaluate(() => (document.querySelector('meta[name="user-login"]') || {}).content || '').catch(() => '');

  await tab.goto(PR_URL);
  if (!(await login())) {
    await tab.goto(`https://github.com/login?return_to=${encodeURIComponent(new URL(PR_URL).pathname)}`);
    console.log('WAITING: sign in to GitHub in the Chrome for Testing window (up to 15 minutes).');
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!(await login())) {
      if (Date.now() > deadline) throw new Error('Not signed in after 15 minutes');
      await sleep(2000);
    }
  }
  console.log(`Signed in as ${await login()}`);

  // Switches theme the way GitHub does: a theme's stylesheet is a link[data-color-theme] whose href may still be
  // in data-href until used. Only the attributes would leave sticky headers transparent and colors half-applied.
  const useTheme = async (page, mode) => {
    if (mode === 'account') return page.evaluate(() => document.documentElement.dataset.colorMode);
    await page.evaluate(async (m) => {
      const link = document.querySelector(`link[data-color-theme="${m}"]`);
      if (link && !link.getAttribute('href') && link.dataset.href) {
        await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; link.href = link.dataset.href; });
      }
      const html = document.documentElement;
      html.dataset.colorMode = m === 'light' ? 'light' : 'dark';
      if (m === 'light') html.dataset.lightTheme = 'light';
    }, mode);
    return mode;
  };
  const ready = async (url, mode) => {
    await tab.goto(url, { waitUntil: 'load' });
    await tab.waitForFunction(() => document.getElementById('pending-review-nag') !== null, null, { timeout: 15000 });
    const used = await useTheme(tab, mode);
    await sleep(2500);
    return used;
  };
  const showFirstPendingComment = () => tab.evaluate(() => {
    const badge = document.querySelector('[data-testid="pending-badge"]');
    if (badge) badge.scrollIntoView({ block: 'center' });
  });
  const shot = (name, extra = {}) => tab.screenshot({ path: out(name), scale: 'css', ...extra });

  await ready(`${PR_URL}/changes?diff=unified`, 'light');
  await shot('raw-1-files-light.png');
  console.log(`account theme: ${await ready(`${PR_URL}/changes?diff=unified`, 'account')}`);
  await shot('raw-2-files-dark.png');
  await ready(PR_URL, 'light');
  await showFirstPendingComment();
  await sleep(1000);
  await shot('raw-3-overview.png');
  // Close-up: a small 640x400 window at 2x pixels (= 1280x800). GitHub's narrow layout keeps comment and bar together.
  await tab.setViewportSize({ width: 640, height: 400 });
  await ready(`${PR_URL}/changes?diff=unified`, 'light');
  await showFirstPendingComment();
  await sleep(1000);
  await shot('raw-4-closeup.png', { scale: 'device' });
  await tab.setViewportSize({ width: 1280, height: 800 });
  await ready(`${PR_URL}/changes`, 'light');
  await tab.locator('#pending-review-nag button.finish').click();
  await sleep(2000);
  await shot('raw-5-review-box.png');
  await tab.keyboard.press('Escape');
  await sleep(500);

  // Demo GIF from a recorded page: PR list -> into the PR (bar appears) -> Files changed -> Finish review -> close.
  const demo = await context.newPage();
  await demo.goto(PR_URL.replace(/\/pull\/\d+$/, '/pulls'), { waitUntil: 'load' });
  await useTheme(demo, 'light');
  const t0 = Date.now();
  await sleep(1500);
  await demo.click(`a[href$="${new URL(PR_URL).pathname}"]`);
  await demo.waitForFunction(() => document.getElementById('pending-review-nag') !== null, null, { timeout: 15000 });
  await useTheme(demo, 'light');
  await sleep(3000);
  await demo.click('a[href$="/changes"], a[href$="/files"]');
  await demo.waitForURL(/\/(changes|files)/, { timeout: 15000 });
  await useTheme(demo, 'light');
  await sleep(3500);
  await demo.locator('#pending-review-nag button.finish').click();
  await sleep(3000);
  await demo.keyboard.press('Escape');
  await sleep(3000);
  const recordedSince = (Date.now() - t0) / 1000;
  const video = demo.video();
  await demo.close();
  const webm = await video.path();
  // Keep only the part after the list finished loading (the end of the recording).
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', `-${recordedSince.toFixed(1)}`, '-i', webm,
    '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0', out('demo.gif')]);

  // Compose on a blank page: the extension runs only on github.com, so nothing extra appears.
  const canvas = await context.newPage();
  await canvas.setViewportSize({ width: 1280, height: 800 });
  const icon = fs.readFileSync(path.join(EXTENSION_DIR, 'icons/icon-128.png')).toString('base64');
  for (const [name, caption] of CAPTIONS) {
    const raw = fs.readFileSync(out(`raw-${name}`)).toString('base64');
    await canvas.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;overflow:hidden;
      background:linear-gradient(160deg,#24292f,#0d1117);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
      <div style="height:112px;display:flex;align-items:center;justify-content:center;gap:18px;color:#fff;font-size:34px;font-weight:700">
        <img src="data:image/png;base64,${icon}" width="52" height="52" alt="">${caption}</div>
      <div style="display:flex;justify-content:center"><img src="data:image/png;base64,${raw}"
        style="width:1065px;height:666px;border-radius:10px 10px 0 0;box-shadow:0 -4px 30px rgba(0,0,0,.5)" alt=""></div>
      </body></html>`);
    await sleep(300);
    await canvas.screenshot({ path: out(name), scale: 'css' });
  }
  const hero = fs.readFileSync(out('raw-1-files-light.png')).toString('base64');
  await canvas.setViewportSize({ width: 1400, height: 560 });
  await canvas.setContent(`<!doctype html><html><body style="margin:0;width:1400px;height:560px;overflow:hidden;display:flex;
    background:linear-gradient(135deg,#2d333b,#0d1117);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#fff">
    <div style="width:560px;padding:0 0 0 64px;display:flex;flex-direction:column;justify-content:center;gap:18px">
      <img src="data:image/png;base64,${icon}" width="96" height="96" alt="">
      <div style="font-size:44px;font-weight:800;line-height:1.1">Unsubmitted Review Alert</div>
      <div style="font-size:24px;color:#c9d1d9;line-height:1.35">Never forget to submit a GitHub pull request review.</div>
    </div>
    <div style="flex:1;position:relative"><img src="data:image/png;base64,${hero}"
      style="position:absolute;left:40px;bottom:0;width:900px;border-radius:10px 10px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.6)" alt=""></div>
    </body></html>`);
  await sleep(300);
  await canvas.screenshot({ path: out('marquee-1400x560.png'), scale: 'css' });

  await context.close();
  fs.rmSync(videoDir, { recursive: true, force: true });
  for (const file of fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png'))) {
    // The store rejects images with an alpha channel in some widgets; flatten to be safe.
    execFileSync('magick', [out(file), '-background', 'white', '-alpha', 'remove', '-alpha', 'off', out(file)]);
  }
  console.log(`Done: ${fs.readdirSync(OUT_DIR).join(', ')}`);
})();
