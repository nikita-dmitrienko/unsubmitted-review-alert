// Unsubmitted Review Alert for GitHub: warns when you have an unsubmitted review on a pull request.
// Runs on all of github.com because GitHub soft-navigates into PRs without a new page load.
(() => {
  'use strict';

  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const CONFLICTS_PATH = /^\/[^/]+\/[^/]+\/pull\/\d+\/conflicts(?:\/|$)/;
  const TITLE_PREFIX = '⚠ PENDING REVIEW · ';
  const HOST_ID = 'pending-review-nag';
  const CHECK_DELAY_MS = 300;
  const LEAVE_APPROVAL_MS = 4000;
  const ANNOUNCE_DELAY_MS = 500;
  const FAVICON_ID = 'pending-review-nag-favicon';
  const PARKED_REL = 'data-pending-review-nag-rel';
  const FAVICON_HREF = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<path d="M16 2.5 30.5 28.5h-29z" fill="#cf222e" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>' +
    '<path d="M16 11.5v8" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>' +
    '<circle cx="16" cy="24" r="2" fill="#fff"/></svg>',
  );

  // Selectors come from GitHub's shipped code (late 2026); bare "Pending" text is deliberately never matched.
  const REVIEW_BUTTON = 'button[class*="ReviewMenuButton"]';
  const REVIEW_BUTTON_COUNTER = '[data-component="ButtonCounter"]';
  // A single selector, not a list: a list loses Chrome's attribute fast path (about 16 ms vs 0.1 ms on huge pages).
  const PENDING_BADGE = '[data-testid="pending-badge"]';
  const LEGACY_PENDING_STATE = '.is-review-pending';
  const LEGACY_PENDING_COUNT = '.js-pending-review-comment-count';
  const LEGACY_PENDING_COMMENT = '.js-pending-review-comment';
  const LEGACY_REVIEW_BUTTON = '.js-reviews-toggle';
  const EMBEDDED_DATA = 'react-app[app-name="repo"] script[data-target="react-app.embeddedData"]';
  const REVIEW_DIALOG = '[role="dialog"][aria-label="Review changes"], [role="dialog"][aria-labelledby="anchored-review-title"]';
  const DISCARD_BUTTON = '[data-dd-action-name="pull_requests.review.discard"]';

  let pending = { active: false, count: 0, prKey: null };
  let bannerHiddenFor = null;
  let leaveApprovedUntil = 0;
  let checkTimer = 0;
  let observer = null;
  let beforeUnloadArmed = false;
  let embeddedCache = { script: null, count: 0, maxBadges: 0 };
  // A discard the user confirmed: { prKey, staleCount, done }. See countAfterDiscard.
  let discardState = null;
  // Last known count per PR, for PR tabs (Checks, Commits) that show no pending signal of their own.
  // fromButton: read from the live review button, which is newer than any page-load snapshot.
  const knownCounts = new Map();

  function prKeyOf(url) {
    if (CONFLICTS_PATH.test(url.pathname)) return null;
    const match = PR_PATH.exec(url.pathname);
    return match ? `/${match[1]}/${match[2]}/pull/${match[3]}`.toLowerCase() : null;
  }

  function prPathOfLocation() {
    const match = PR_PATH.exec(location.pathname);
    return match ? match[0].replace(/\/$/, '') : null;
  }

  function toInt(node) {
    return node ? parseInt(node.textContent, 10) || 0 : 0;
  }

  function normalizedPath(pathname) {
    return pathname.replace(/\/$/, '').toLowerCase();
  }

  // Server state at page load. Trusted only on the route it was rendered for, and dropped once a
  // pending comment disappears from the page, because GitHub never updates it in place.
  // Returns null when the snapshot does not apply to this page.
  function embeddedPendingCount(badges) {
    // While parsing, the script can hold half its JSON; DOMContentLoaded schedules a re-check.
    if (document.readyState === 'loading') return null;
    const script = document.querySelector(EMBEDDED_DATA);
    if (!script) return null;
    const initialPath = script.closest('react-app').getAttribute('initial-path');
    if (!initialPath || normalizedPath(new URL(initialPath, location.origin).pathname) !== normalizedPath(location.pathname)) {
      return null;
    }
    if (embeddedCache.script !== script) {
      embeddedCache = { script, count: parseEmbeddedCount(script), maxBadges: 0 };
    }
    if (badges < embeddedCache.maxBadges) embeddedCache.count = 0;
    embeddedCache.maxBadges = Math.max(embeddedCache.maxBadges, badges);
    return embeddedCache.count;
  }

  function parseEmbeddedCount(script) {
    try {
      const review = JSON.parse(script.textContent).payload.pullRequestsLayoutRoute.viewerPendingReview;
      return review && review.id && Array.isArray(review.comments) ? review.comments.length : 0;
    } catch {
      return 0;
    }
  }

  function detectPendingCount(prKey) {
    const reviewButton = document.querySelector(REVIEW_BUTTON);
    // The live React button has no counter when nothing is pending, so it outranks every other signal.
    if (reviewButton) {
      const count = toInt(reviewButton.querySelector(REVIEW_BUTTON_COUNTER));
      knownCounts.set(prKey, { count, fromButton: true });
      return count;
    }

    const badges = document.querySelectorAll(PENDING_BADGE).length;
    const legacyPending = document.querySelector(LEGACY_PENDING_STATE) !== null;
    let legacyCount = 0;
    for (const node of document.querySelectorAll(LEGACY_PENDING_COUNT)) {
      legacyCount = Math.max(legacyCount, toInt(node));
    }
    const known = knownCounts.get(prKey);
    if (!known || !known.fromButton) {
      const snapshot = embeddedPendingCount(badges);
      if (snapshot !== null) knownCounts.set(prKey, { count: snapshot, fromButton: false });
    }
    return Math.max(
      badges,
      document.querySelectorAll(LEGACY_PENDING_COMMENT).length,
      legacyPending ? Math.max(legacyCount, 1) : 0,
      knownCounts.has(prKey) ? knownCounts.get(prKey).count : 0,
    );
  }

  // GitHub's Overview tab closes its review box after a successful discard but keeps its own counter and
  // "Pending" badges (it never clears its pending-review state; Files changed reloads instead). So: the box
  // closing after the discard request started means success, and that stale count is ignored until the page
  // shows a different one. A failed request keeps the box open and resets the button, which cancels this.
  function countAfterDiscard(prKey, count) {
    const state = discardState;
    if (!state || state.prKey !== prKey) return count;
    if (!state.done) {
      const box = document.querySelector(REVIEW_DIALOG);
      if (!box) {
        state.done = true;
      } else {
        const button = box.querySelector(DISCARD_BUTTON);
        if (!button || button.getAttribute('data-loading') !== 'true') discardState = null;
        return count;
      }
    }
    if (count === state.staleCount) return 0;
    discardState = null;
    return count;
  }

  function discardButtonFromEvent(event) {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.matches(DISCARD_BUTTON)) return node;
    }
    return null;
  }

  // Runs before GitHub's own handler, which asks confirm() and, only on OK, marks the button as loading.
  function watchDiscard(button) {
    const prKey = pending.prKey;
    const staleCount = pending.count;
    setTimeout(() => {
      if (!prKey || button.getAttribute('data-loading') !== 'true') return;
      discardState = { prKey, staleCount, done: false };
      scheduleCheck();
    }, 0);
  }

  function scheduleCheck() {
    if (!checkTimer) checkTimer = setTimeout(runCheck, CHECK_DELAY_MS);
  }

  function runCheck() {
    checkTimer = 0;
    const prKey = prKeyOf(location);
    const count = prKey ? countAfterDiscard(prKey, detectPendingCount(prKey)) : 0;
    pending = { active: count > 0, count, prKey: count > 0 ? prKey : null };
    syncTitle();
    syncFavicon();
    syncBanner();
    syncBeforeUnload();
    if (prKey) startObserving();
    else stopObserving();
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(scheduleCheck);
    // characterData: React updates the review button's counter text in place.
    observer.observe(document, { childList: true, characterData: true, subtree: true });
  }

  function stopObserving() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  function syncTitle() {
    // Strip-then-prepend keeps this idempotent next to GitHub's and other extensions' title edits.
    const bareTitle = document.title.split(TITLE_PREFIX).join('');
    const wantedTitle = pending.active ? TITLE_PREFIX + bareTitle : bareTitle;
    if (document.title !== wantedTitle) document.title = wantedTitle;
  }

  // A warning favicon stands out in a crowded tab strip where the title is cut off. GitHub's own icon links
  // (which it also swaps for CI status) are parked, not removed, so only ours is declared and theirs come back.
  function syncFavicon() {
    const head = document.head;
    if (!head) return;
    const ours = document.getElementById(FAVICON_ID);
    if (!pending.active) {
      if (ours) ours.remove();
      for (const link of head.querySelectorAll(`link[${PARKED_REL}]`)) {
        link.setAttribute('rel', link.getAttribute(PARKED_REL));
        link.removeAttribute(PARKED_REL);
      }
      return;
    }
    for (const link of head.querySelectorAll('link[rel~="icon"]')) {
      if (link.id === FAVICON_ID) continue;
      link.setAttribute(PARKED_REL, link.getAttribute('rel'));
      link.removeAttribute('rel');
    }
    if (!ours) {
      const link = document.createElement('link');
      link.id = FAVICON_ID;
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      link.href = FAVICON_HREF;
      head.appendChild(link);
    }
  }

  function describeCount(count) {
    return count === 1 ? '1 pending comment' : `${count} pending comments`;
  }

  function syncBanner() {
    let host = document.getElementById(HOST_ID);
    // Stays out of the way while GitHub's review dialog is open; its Submit button sits at the bottom too.
    const reviewDialogOpen = document.querySelector(REVIEW_DIALOG) !== null;
    const showBanner = pending.active && bannerHiddenFor !== pending.prKey && !reviewDialogOpen;
    if (!showBanner) {
      if (host) host.remove();
      return;
    }
    const created = !host;
    if (created) {
      if (!document.documentElement) return;
      host = createBanner();
      // Attached to <html> so Turbo's <body> swaps do not remove it.
      document.documentElement.appendChild(host);
    }
    const countText = host.shadowRoot.querySelector('.count');
    const wantedText = describeCount(pending.count);
    if (countText.textContent !== wantedText) countText.textContent = wantedText;
    // Screen readers: one polite message when the bar appears and when the count changes. A live region
    // filled in the same task it is inserted is not reliably announced, so a new bar's message waits.
    const announcer = host.shadowRoot.querySelector('.announce');
    const message = `Review not submitted: ${wantedText}, visible only to you until you submit.`;
    if (announcer.textContent !== message) {
      setTimeout(() => { announcer.textContent = message; }, created ? ANNOUNCE_DELAY_MS : 0);
    }
  }

  // The host is a block at the end of <html>, sized to the fixed bar, so the page can scroll its last
  // lines (GitHub's comment box, the footer) out from under the bar instead of being covered by it.
  // Colors: GitHub's own Primer variables (inherited through the shadow boundary), so the bar follows the
  // user's GitHub theme: light, dark, dimmed, high contrast, colorblind, or "sync with system". The --ura-*
  // values are GitHub's light/dark defaults, used only if a page lacks the Primer variables.
  const BANNER_CSS = `
    :host { all: initial; display: block; }
    .bar {
      --ura-bg: #ffffff; --ura-tint: #ffebe9; --ura-fg: #1f2328; --ura-muted: #59636e; --ura-danger: #d1242f;
      --ura-danger-strong: #cf222e; --ura-danger-hover: #a40e26; --ura-on-strong: #ffffff; --ura-border: #d1d9e0;
      --ura-button: #f6f8fa; --ura-button-hover: #eff2f5; --ura-button-fg: #25292e; --ura-focus: #0969da;
      --tint: var(--bgColor-danger-muted, var(--ura-tint));
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
      display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap;
      padding: 8px 16px 8px 20px;
      /* The danger tint is translucent in dark themes, so it is layered over the opaque page color. */
      background: linear-gradient(var(--tint), var(--tint)), var(--bgColor-default, var(--ura-bg));
      color: var(--fgColor-default, var(--ura-fg));
      font: 400 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      box-shadow: inset 4px 0 0 var(--fgColor-danger, var(--ura-danger)),
        0 -1px 0 var(--borderColor-danger-emphasis, var(--ura-danger-strong)), 0 -8px 24px rgba(1, 4, 9, 0.18);
    }
    @media (prefers-color-scheme: dark) {
      .bar {
        --ura-bg: #0d1117; --ura-tint: #f851491a; --ura-fg: #f0f6fc; --ura-muted: #9198a1; --ura-danger: #f85149;
        --ura-danger-strong: #da3633; --ura-danger-hover: #b62324; --ura-border: #3d444d;
        --ura-button: #212830; --ura-button-hover: #262c36; --ura-button-fg: #f0f6fc; --ura-focus: #1f6feb;
      }
    }
    .icon { color: var(--fgColor-danger, var(--ura-danger)); font-size: 18px; line-height: 20px; }
    .text { flex: 1 1 280px; }
    .headline { font-weight: 600; }
    .muted { color: var(--fgColor-muted, var(--ura-muted)); }
    .announce {
      position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
    }
    button {
      font: inherit; font-weight: 600; padding: 5px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid transparent;
    }
    button:focus-visible { outline: 2px solid var(--focus-outlineColor, var(--ura-focus)); outline-offset: 2px; }
    .finish {
      background: var(--bgColor-danger-emphasis, var(--ura-danger-strong));
      border-color: var(--bgColor-danger-emphasis, var(--ura-danger-strong));
      color: var(--fgColor-onEmphasis, var(--ura-on-strong));
    }
    .finish:hover { filter: brightness(0.9); }
    .hide {
      background: var(--button-default-bgColor-rest, var(--ura-button));
      border-color: var(--button-default-borderColor-rest, var(--ura-border));
      color: var(--button-default-fgColor-rest, var(--ura-button-fg));
    }
    .hide:hover { background: var(--button-default-bgColor-hover, var(--ura-button-hover)); }
    /* Windows contrast themes drop backgrounds and shadows; a system-colored edge keeps the bar distinct. */
    @media (forced-colors: active) {
      .bar { border-top: 2px solid CanvasText; border-left: 4px solid Mark; }
    }
  `;

  function createBanner() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(BANNER_CSS);
    shadow.adoptedStyleSheets = [sheet];

    const bar = document.createElement('div');
    bar.className = 'bar';
    // A named landmark, so screen reader users can jump to it; announcing is the .announce region's job
    // (role="alert" here would interrupt speech on every page load and every new comment).
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Unsubmitted review');

    const announcer = document.createElement('span');
    announcer.className = 'announce';
    announcer.setAttribute('role', 'status');

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';

    const text = document.createElement('span');
    text.className = 'text';
    const headline = document.createElement('span');
    headline.className = 'headline';
    headline.textContent = 'Review not submitted';
    const count = document.createElement('span');
    count.className = 'count';
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = ', visible only to you until you submit';
    text.append(headline, ' · ', count, detail);

    const finish = document.createElement('button');
    finish.className = 'finish';
    finish.type = 'button';
    finish.textContent = 'Finish review';
    finish.addEventListener('click', openReview);

    const hide = document.createElement('button');
    hide.className = 'hide';
    hide.type = 'button';
    hide.textContent = 'Hide';
    // The accessible name starts with the visible label (WCAG 2.5.3), so voice control "click Hide" works.
    hide.setAttribute('aria-label', 'Hide review reminder');
    hide.title = 'Hides this bar until the page reloads. The tab icon, tab title and leave warnings stay on.';
    hide.addEventListener('click', () => {
      bannerHiddenFor = pending.prKey;
      syncBanner();
    });

    bar.append(icon, text, finish, hide, announcer);
    shadow.append(bar);
    // The bar wraps to two lines on narrow windows; the reserved space follows its real height.
    new ResizeObserver(() => { host.style.height = `${bar.offsetHeight}px`; }).observe(bar);
    return host;
  }

  function openReview() {
    const reviewButton = document.querySelector(REVIEW_BUTTON) || document.querySelector(LEGACY_REVIEW_BUTTON);
    if (reviewButton) {
      reviewButton.click();
      return;
    }
    const prPath = prPathOfLocation();
    if (prPath) location.assign(`${prPath}/files`);
  }

  function onBeforeUnload(event) {
    if (!pending.active || Date.now() < leaveApprovedUntil) return;
    event.preventDefault();
    event.returnValue = true;
  }

  function syncBeforeUnload() {
    // Armed only while pending, as MDN and Chrome's page lifecycle guide recommend.
    if (pending.active === beforeUnloadArmed) return;
    beforeUnloadArmed = pending.active;
    if (beforeUnloadArmed) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  }

  function approveLeaving() {
    leaveApprovedUntil = Date.now() + LEAVE_APPROVAL_MS;
  }

  function confirmLeaving() {
    const message =
      `You have an unsubmitted review on this pull request (${describeCount(pending.count)}).\n\n` +
      'Nobody else can see your comments until you submit the review.\n\nLeave anyway?';
    const leave = window.confirm(message);
    if (leave) approveLeaving();
    return leave;
  }

  // The approval window only de-duplicates one navigation (click confirm, then Turbo, then unload).
  function leavesPendingPr(url) {
    return pending.active && Date.now() >= leaveApprovedUntil && prKeyOf(url) !== pending.prKey;
  }

  function linkFromEvent(event) {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLAnchorElement && node.hasAttribute('href')) return node;
    }
    return null;
  }

  function onClickCapture(event) {
    if (!pending.active) return;
    const discardButton = discardButtonFromEvent(event);
    if (discardButton) {
      watchDiscard(discardButton);
      return;
    }
    const isPlainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (!isPlainClick || event.defaultPrevented) return;

    const link = linkFromEvent(event);
    if (!link || link.hasAttribute('download')) return;
    const opensElsewhere = link.target !== '' && !['_self', '_top', '_parent'].includes(link.target);
    if (opensElsewhere) return;
    const url = new URL(link.href, location.href);
    // Cross-origin links are left to the beforeunload prompt; another tab of the same PR is not leaving.
    if (url.origin !== location.origin || prKeyOf(url) === pending.prKey) return;
    if (!confirmLeaving()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onTurboBeforeVisit(event) {
    const url = new URL(event.detail.url, location.href);
    if (leavesPendingPr(url) && !confirmLeaving()) event.preventDefault();
  }

  // Fires before beforeunload. Full page loads that stay on this PR (GitHub's redirect after submitting
  // or discarding a review, the review form post, same-PR links) must not get the unload prompt.
  function onNavigate(event) {
    if (!pending.active || event.navigationType === 'reload') return;
    const destination = new URL(event.destination.url);
    if (event.destination.sameDocument) {
      // Back/Forward inside GitHub's app (no page load, so no beforeunload). Cancelling here runs before
      // popstate, so GitHub's router never sees the move and URL and view stay in sync. Chrome allows
      // cancelling only some traversals (it needs a recent user interaction); otherwise the move goes ahead.
      if (event.navigationType === 'traverse' && event.cancelable && leavesPendingPr(destination) && !confirmLeaving()) {
        event.preventDefault();
      }
      return;
    }
    if (prKeyOf(destination) === pending.prKey) approveLeaving();
  }

  // Capture phase on window runs before Turbo's and React's own click handling.
  window.addEventListener('click', onClickCapture, true);
  document.addEventListener('turbo:before-visit', onTurboBeforeVisit);
  for (const type of ['DOMContentLoaded', 'turbo:load', 'turbo:render', 'soft-nav:end', 'soft-nav:react-done']) {
    document.addEventListener(type, scheduleCheck);
  }
  window.addEventListener('popstate', scheduleCheck);
  window.addEventListener('pageshow', scheduleCheck);
  if (window.navigation) {
    window.navigation.addEventListener('navigate', onNavigate);
    window.navigation.addEventListener('currententrychange', scheduleCheck);
  }
  scheduleCheck();
})();
