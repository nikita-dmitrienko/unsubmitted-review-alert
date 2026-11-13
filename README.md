# Unsubmitted Review Alert for GitHub

![Opening a pull request with a pending review shows the reminder bar; Finish review opens GitHub's review box](store/assets/screenshots/demo.gif)

A Chrome extension (Manifest V3, no permissions besides a content script on github.com) that
notices when you have started a GitHub pull request review but not submitted it, and then:

- shows a compact bar at the bottom of the PR page with the pending comment count and a **Finish review** button
  (the page gets matching space at its end, so the bar covers nothing);
- swaps the tab's favicon for a red warning sign, which stays visible in a crowded tab strip;
- prefixes the tab title with `⚠ PENDING REVIEW · `;
- asks before you leave the PR: links, GitHub's keyboard shortcuts and Back inside GitHub get an in-page question;
  closing the tab, reloading, typing another address and links to other sites get Chrome's "Leave site?" dialog.

The bar uses GitHub's own theme colors, so it follows your GitHub theme; it meets WCAG AA contrast in the
light, dark, both high-contrast and sync-with-system themes (checked on real github.com). For screen readers it is a named landmark ("Unsubmitted review") with a polite
status message; it works with the keyboard and in Windows contrast themes.

No token, no network requests, no storage.

## Install without the store (load unpacked)

1. Get this folder onto the machine (copy it or clone the repo).
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder (the one with `manifest.json`).
4. Open a GitHub PR, start a review, add a comment, and don't submit it: the banner appears.

Since Chrome 134, unpacked extensions run only while Developer mode is on. On a company-managed
Chrome, Developer mode may be blocked by policy; then use a store listing instead.
To update: replace the folder contents and click the reload icon on the extension's card.

## Develop

```bash
npm install                     # Playwright, for the tests only; nothing ships with the extension
npx playwright install chromium # the browser the tests drive
npm test                        # 62 end-to-end checks with the real unpacked extension on routed github.com fixtures
npm run test:smoke              # real public PR pages, logged out: no false positives, timing at 6x CPU throttle
npm run test:real               # real public PR pages: leave prompts with GitHub's own navigation, themes (HEADED=1 to watch)
npm run store-images            # re-render the draft store screenshot and promo tile
npm run icons                   # re-render icons from store/assets/icon.svg (ImageMagick)
npm run package                 # dist/pending-review-nag-<version>.zip for the Chrome Web Store
```

Env overrides for the test scripts: `CHROME_PATH` (a Chrome for Testing / Chromium binary) and
`NODE_PATH` (a folder that already contains `playwright`). Branded Google Chrome ignores
`--load-extension`, so the tests need Chrome for Testing or Chromium.

## Layout

| Path | What |
| --- | --- |
| `extension/` | Everything that ships: `manifest.json`, `content.js`, `icons/` |
| `test/` | `e2e.cjs` (fixtures), `smoke-real-github.cjs` and `real-github.cjs` (real public pages), `signed-in.cjs` (your own signed-in pending review) |
| `scripts/` | icon, store image and zip builders |
| `store/assets/` | store icon, promo tile and the icon source |
| `docs/` | `privacy-policy.html` (served with GitHub Pages) |

## License

[MIT](LICENSE)
