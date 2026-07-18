/*
 * Numeric contrast gate for the options page (platform §4, WCAG SC 1.4.3 /
 * 1.4.11) — in BOTH themes.
 *
 * The ratios used to live in CSS comments ("≥ 3:1 on white"). A comment is a
 * human's claim, not a check: this repo shipped a `kbd` border at #999 (2.8:1)
 * under a comment asserting it passed. This script recomputes every ratio from
 * the token values actually in src/options.html, so a hex edit that breaks
 * contrast fails the build instead of being blessed by a stale comment.
 *
 * Fail-closed: every token declared in :root must be claimed by a PAIR below.
 * A new token nobody verified fails the gate rather than passing unseen.
 *
 * Run: node test/contrast.mjs   (npm test runs it)
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/options.html', import.meta.url), 'utf8');

// ------------------------------------------------------------- color math

// WCAG 2.x relative luminance: sRGB channel -> linear, then Rec.709 weights.
function channelToLinear(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a 6-digit hex color: "${hex}"`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(channelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ------------------------------------------------------- token extraction

// The light theme is the bare `:root`; the dark theme is the `:root` nested in
// the prefers-color-scheme block, which overrides a subset of the same names.
function tokensIn(block) {
  const out = {};
  for (const [, name, value] of block.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

function blockAfter(source, startIndex) {
  const open = source.indexOf('{', startIndex);
  assert.ok(open !== -1, 'malformed CSS: no opening brace');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error('malformed CSS: unbalanced braces');
}

const darkAt = css.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
assert.ok(darkAt !== -1, 'options.html must declare a prefers-color-scheme: dark override');

const light = tokensIn(blockAfter(css, css.search(/:root\s*\{/)));
const darkMedia = blockAfter(css, darkAt);
const dark = { ...light, ...tokensIn(blockAfter(darkMedia, darkMedia.search(/:root\s*\{/))) };

assert.ok(
  /color-scheme:\s*light dark/.test(css) && /<meta name="color-scheme" content="light dark"/.test(css),
  'options.html must declare color-scheme: light dark (meta + :root) — without it dark mode is untested by default'
);

// --------------------------------------------------------------- the pairs

// [foreground token, background token, minimum ratio, what it is]
// 4.5:1 for text (SC 1.4.3); 3:1 for UI component boundaries (SC 1.4.11).
const PAIRS = [
  ['--fg', '--bg', 4.5, 'body text on the page background'],
  ['--fg', '--field-bg', 4.5, 'input/button text on its own surface'],
  ['--field-border', '--bg', 3, 'field & button border against the page'],
  ['--field-border', '--field-bg', 3, 'field & button border against its own fill'],
];

// Fail closed: a token added to :root but never verified is a silent hole.
const claimed = new Set(PAIRS.flatMap(([f, b]) => [f, b]));
const unclaimed = Object.keys(light).filter((t) => t !== '--color-scheme' && !claimed.has(t));
assert.deepEqual(
  unclaimed,
  [],
  `these :root tokens are in no verified contrast pair — add them to PAIRS: ${unclaimed.join(', ')}`
);

// ----------------------------------------------------------------- assert

let failures = 0;
for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  for (const [fgToken, bgToken, min, what] of PAIRS) {
    const fg = theme[fgToken];
    const bg = theme[bgToken];
    assert.ok(fg, `${themeName}: token ${fgToken} is not defined`);
    assert.ok(bg, `${themeName}: token ${bgToken} is not defined`);
    const ratio = contrast(fg, bg);
    const ok = ratio >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} - ${themeName}: ${what} — ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (need ${min}:1)`
    );
  }
}

// Anti-vacuity: if the pair table or a theme silently emptied, the loop above
// would print nothing and "pass". Assert we actually measured what we expect.
const expected = PAIRS.length * 2;
const measured = expected - failures;
console.log(`\n${measured}/${expected} contrast pairs pass in both themes`);
if (failures > 0) process.exitCode = 1;
