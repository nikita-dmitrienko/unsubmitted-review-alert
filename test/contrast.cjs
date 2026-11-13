// Runs in the page (pass to page.evaluate): WCAG contrast ratios of the bar's text and buttons against
// the colors Chrome actually computed, with the translucent danger tint composited over the page color.
module.exports.barContrast = () => {
  const root = document.getElementById('pending-review-nag').shadowRoot;
  const bar = root.querySelector('.bar');
  const ctx = document.createElement('canvas').getContext('2d');
  const rgba = (color) => {
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    const s = ctx.fillStyle;
    if (s[0] === '#') return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(1);
    const m = s.match(/[\d.]+/g).map(Number);
    return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const style = (sel) => getComputedStyle(root.querySelector(sel));
  const barBg = over(rgba(getComputedStyle(bar).getPropertyValue('--tint').trim()), rgba(getComputedStyle(bar).backgroundColor));
  const onBar = (sel) => ratio(rgba(style(sel).color), barBg);
  const onOwn = (sel) => ratio(rgba(style(sel).color), over(rgba(style(sel).backgroundColor), barBg));
  return {
    background: `rgb(${barBg.slice(0, 3).map(Math.round).join(', ')})`,
    text: onBar('.headline'),
    muted: onBar('.muted'),
    icon: onBar('.icon'),
    finish: onOwn('.finish'),
    hide: onOwn('.hide'),
  };
};

// WCAG AA: 4.5 for text (all text here is 14px), 3 for the non-text warning icon.
module.exports.assertReadable = (assert, c, label) => {
  for (const key of ['text', 'muted', 'finish', 'hide']) {
    assert.ok(c[key] >= 4.5, `${label}: ${key} contrast ${c[key]} < 4.5 (${JSON.stringify(c)})`);
  }
  assert.ok(c.icon >= 3, `${label}: icon contrast ${c.icon} < 3 (${JSON.stringify(c)})`);
};
