/*
 * Unit tests for the audit and apply engines under linkedom.
 *
 * The single most important invariant lives here: every selector the audit
 * emits must re-find exactly the element it was computed from —
 *   document.querySelector(selectorFor(el)) === el
 * The whole architecture (apply, LLM label round-trip, undo) rides on it.
 *
 * Run: node test/unit.mjs   (or npm test)
 */

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';

const require = createRequire(import.meta.url);
const audit = require('../src/audit.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

function doc(html) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
}

// ---------------------------------------------------------------- selectors

console.log('selectorFor round-trip');

test('element under an id ancestor', () => {
  const d = doc('<section id="wrap"><div></div><div><button></button></div></section>');
  const el = d.querySelector('button');
  const sel = audit.selectorFor(el);
  assert.equal(d.querySelector(sel), el, `selector "${sel}" did not re-find the element`);
});

test('deeply nested element with no ids anywhere', () => {
  const d = doc(
    '<div><div><div><div><div><div><div><button>x</button></div></div></div></div></div></div></div>'
  );
  const el = d.querySelector('button');
  const sel = audit.selectorFor(el);
  assert.equal(d.querySelector(sel), el, `selector "${sel}" did not re-find the element`);
});

test('identical repeated cards resolve to distinct elements', () => {
  const card = '<div class="card"><div><div><div><div><div><button></button></div></div></div></div></div></div>';
  const d = doc(card + card + card);
  const buttons = [...d.querySelectorAll('button')];
  const selectors = buttons.map((b) => audit.selectorFor(b));
  assert.equal(new Set(selectors).size, buttons.length, 'selectors collide across identical cards');
  buttons.forEach((b, i) => {
    assert.equal(d.querySelector(selectors[i]), b, `selector "${selectors[i]}" hit the wrong card`);
  });
});

test('round-trip holds for every control and heading in the fixtures', () => {
  const fixtures = ['synthetic-broken', 'hackernews', 'craigslist', 'wikipedia']
    .map((n) => new URL(`../fixtures/${n}.html`, import.meta.url).pathname)
    .filter(existsSync);
  assert.ok(fixtures.length > 0, 'no fixtures found');
  for (const path of fixtures) {
    const { document: d } = parseHTML(readFileSync(path, 'utf8'));
    const els = d.querySelectorAll(
      'button, a[href], input, select, textarea, h1, h2, h3, h4, h5, h6'
    );
    for (const el of els) {
      const sel = audit.selectorFor(el);
      assert.equal(d.querySelector(sel), el, `${path}: "${sel}" did not re-find its element`);
    }
  }
});

// ----------------------------------------------------------------- headings

console.log('heading repair');

function repairsFor(html) {
  const issues = audit.run(doc(html)).issues;
  const h = issues.find((i) => i.kind === 'heading-structure');
  return h ? h.repairs.map((r) => `${r.from}->${r.to}`) : [];
}

test('sibling run stays a sibling run (h1,h3,h3 -> 1,2,2)', () => {
  assert.deepEqual(repairsFor('<h1>a</h1><h3>b</h3><h3>c</h3>'), ['3->2', '3->2']);
});

test('returning to a seen level rejoins its repaired level (h1,h3,h5,h3)', () => {
  assert.deepEqual(repairsFor('<h1>a</h1><h3>b</h3><h5>c</h5><h3>d</h3>'), [
    '3->2',
    '5->3',
    '3->2',
  ]);
});

test('new shallower level after a deep branch (h1,h3,h3,h2,h3 -> 1,2,2,2,3)', () => {
  assert.deepEqual(repairsFor('<h1>a</h1><h3>b</h3><h3>c</h3><h2>d</h2><h3>e</h3>'), [
    '3->2',
    '3->2',
  ]);
});

test('first heading is never promoted to h1', () => {
  assert.deepEqual(repairsFor('<h2>banner</h2><h1>title</h1><h2>section</h2>'), []);
  assert.deepEqual(repairsFor('<h2>a</h2><h4>b</h4>'), ['4->3']);
});

test('clean outline produces no repairs', () => {
  assert.deepEqual(repairsFor('<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>'), []);
});

test('re-audit after repair is idempotent (aria-level wins over tag)', () => {
  const d = doc('<h1>a</h1><h3>b</h3><h3>c</h3>');
  const first = audit.run(d).issues.find((i) => i.kind === 'heading-structure');
  for (const r of first.repairs) {
    const el = d.querySelector(r.selector);
    el.setAttribute('role', 'heading');
    el.setAttribute('aria-level', String(r.to));
  }
  const second = audit.run(d).issues.find((i) => i.kind === 'heading-structure');
  assert.equal(second, undefined, 're-audit found phantom repairs on an already-fixed page');
});

// ------------------------------------------------------------------ accname

console.log('accessible name');

function flagged(html, selector) {
  const d = doc(html);
  const el = d.querySelector(selector);
  const issues = audit.run(d).issues.filter((i) => i.kind === 'unlabeled-control');
  return issues.some((i) => d.querySelector(i.selector) === el);
}

test('textarea with label[for] is not flagged', () => {
  assert.equal(flagged('<label for="m">Your message</label><textarea id="m"></textarea>', 'textarea'), false);
});

test('select inside a wrapping label is not flagged', () => {
  assert.equal(flagged('<label>Country <select><option>US</option></select></label>', 'select'), false);
});

test('input with only a placeholder is not flagged (placeholder is the fallback name)', () => {
  assert.equal(flagged('<input type="text" placeholder="Search">', 'input'), false);
});

test('bare icon button is flagged', () => {
  assert.equal(flagged('<button class="icon-search"></button>', 'button'), true);
});

// -------------------------------------------------------------------- apply

console.log('apply + undo');

test('patches apply, record originals, and undo restores the page', () => {
  const d = doc(
    '<section id="wrap"><h4 aria-level="4">deep</h4><div><button aria-label="Old">x</button></div></section>'
  );
  globalThis.document = d;
  // Fresh require so the module binds to this document.
  delete require.cache[require.resolve('../src/apply.js')];
  const apply = require('../src/apply.js');

  const h = d.querySelector('h4');
  const b = d.querySelector('button');
  const patches = [
    { selector: audit.selectorFor(h), attrs: { role: 'heading', 'aria-level': '2' } },
    { selector: audit.selectorFor(b), attrs: { 'aria-label': 'Search', 'aria-description': 'Auto-labeled, unverified' } },
    { selector: '#does-not-exist', attrs: { role: 'main' } },
  ];
  const result = apply.applyPatches(patches);
  assert.equal(result.applied.length, 2, 'applied count must reflect real applications');
  assert.equal(result.total, 3);
  assert.equal(h.getAttribute('aria-level'), '2');
  assert.equal(b.getAttribute('aria-label'), 'Search');
  assert.equal(b.getAttribute('aria-description'), 'Auto-labeled, unverified');
  assert.equal(b.getAttribute('data-page-repair'), '1');

  const restored = apply.undoAll();
  assert.equal(restored, 2);
  assert.equal(h.getAttribute('aria-level'), '4', 'pre-existing value must be restored');
  assert.equal(h.getAttribute('role'), null, 'added attribute must be removed');
  assert.equal(b.getAttribute('aria-label'), 'Old', 'pre-existing label must be restored');
  assert.equal(b.getAttribute('aria-description'), null);
  assert.equal(b.getAttribute('data-page-repair'), null);
  delete globalThis.document;
});

test('patchesFromIssues keeps provenance out of the accessible name', () => {
  globalThis.document = doc('<div></div>');
  delete require.cache[require.resolve('../src/apply.js')];
  const apply = require('../src/apply.js');
  const labels = new Map([
    ['#a', { label: 'Search' }],
    ['#b', { label: 'Upvote story', unverified: true }],
  ]);
  const issues = [
    { kind: 'unlabeled-control', selector: '#a' },
    { kind: 'unlabeled-control', selector: '#b' },
    { kind: 'unlabeled-control', selector: '#c' }, // no label -> no patch
  ];
  const patches = apply.patchesFromIssues(issues, labels);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0].attrs, { 'aria-label': 'Search' });
  assert.deepEqual(patches[1].attrs, {
    'aria-label': 'Upvote story',
    'aria-description': 'Auto-labeled, unverified',
  });
  delete globalThis.document;
});

// ------------------------------------------------ isolated overlay container

console.log('isolated overlay container (§2.3)');

test('createIsolatedHost mounts a shadow-rooted, marked host in the page', () => {
  const d = doc('<main>host page</main>');
  globalThis.document = d;
  delete require.cache[require.resolve('../src/isolate.js')];
  const isolate = require('../src/isolate.js');
  const { host, root, reused } = isolate.createIsolatedHost('page-repair-panel');
  assert.equal(reused, false);
  assert.equal(host.id, 'page-repair-panel');
  assert.equal(host.getAttribute('data-page-repair'), '1', 'host carries the undo/cleanup marker');
  assert.equal(host.parentNode, d.body, 'host attaches to the page body');
  assert.ok(host.shadowRoot, 'an (open) shadow root is created');
  assert.equal(root.host, host, 'the returned root belongs to the host');
  assert.ok(root.querySelector('style'), 'the base reset style is injected into the shadow root');
  delete globalThis.document;
});

test('createIsolatedHost is idempotent — never double-attaches a shadow root', () => {
  const d = doc('<main>x</main>');
  globalThis.document = d;
  delete require.cache[require.resolve('../src/isolate.js')];
  const isolate = require('../src/isolate.js');
  const first = isolate.createIsolatedHost('page-repair-panel');
  const second = isolate.createIsolatedHost('page-repair-panel'); // must not throw
  assert.equal(second.reused, true, 'a re-invocation reuses the existing host');
  assert.equal(second.host, first.host);
  assert.equal(second.root, first.root);
  assert.equal(d.querySelectorAll('#page-repair-panel').length, 1, 'no duplicate hosts stack up');
  delete globalThis.document;
});

test('the base reset encodes the §2.3 / §5.2 invariants (mechanical check on prose)', () => {
  delete require.cache[require.resolve('../src/isolate.js')];
  const isolate = require('../src/isolate.js'); // no document needed to read the constant
  assert.match(isolate.BASE_STYLE, /all:\s*initial/, 'must neutralize inherited host styles');
  assert.match(isolate.BASE_STYLE, /prefers-reduced-motion/, 'must carry a reduced-motion path');
  assert.match(isolate.BASE_STYLE, /color-scheme:\s*light dark/, 'must not fight the host theme');
});

test('remove() detaches the host, and reports whether one was present', () => {
  const d = doc('<main>x</main>');
  globalThis.document = d;
  delete require.cache[require.resolve('../src/isolate.js')];
  const isolate = require('../src/isolate.js');
  isolate.createIsolatedHost('page-repair-panel');
  assert.equal(isolate.remove('page-repair-panel'), true);
  assert.equal(d.getElementById('page-repair-panel'), null, 'host is gone after remove');
  assert.equal(isolate.remove('page-repair-panel'), false, 'removing an absent host reports false');
  delete globalThis.document;
});

// -------------------------------------------------------- never block paste

console.log('never-block-paste (§5.1)');

// Load the real content-script source with the host globals it expects, so the
// tests below exercise the shipped file, not a stand-in. content.js is not a
// CommonJS module (it runs as an injected classic script), so we evaluate its
// source with document / chrome / location provided on globalThis.
function loadContentScript(d, chromeStub, locationStub) {
  globalThis.document = d;
  globalThis.location = locationStub;
  globalThis.chrome = chromeStub;
  delete require.cache[require.resolve('../src/audit.js')];
  delete require.cache[require.resolve('../src/apply.js')];
  globalThis.PageRepairAudit = require('../src/audit.js');
  globalThis.PageRepairApply = require('../src/apply.js');
  const src = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)(); // free identifiers resolve to the globals set above
}

function cleanupContentGlobals() {
  for (const k of ['document', 'location', 'chrome', 'window', 'PageRepairAudit', 'PageRepairApply']) {
    delete globalThis[k];
  }
}

// A heading skip is a deterministic (non-LLM) issue, so repairPage runs fully
// synchronously — no phase-2 network round trip — and we can assert right after
// invoking, before any await.
const FORBIDDEN_HOST_EVENTS = ['paste', 'copy', 'cut', 'keydown', 'keyup', 'keypress', 'beforeinput'];

test('a repair pass registers no clipboard/key listener on document or window', () => {
  const d = doc('<h1>Title</h1><h3>Skipped level</h3><p>body</p>');
  const hostTypes = [];
  const realAdd = d.addEventListener.bind(d);
  d.addEventListener = (type, ...rest) => { hostTypes.push(type); return realAdd(type, ...rest); };
  globalThis.window = { addEventListener: (type) => hostTypes.push(type), removeEventListener() {} };

  const messageListeners = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: async () => ({ labels: [] }),
    },
  };
  loadContentScript(d, chromeStub, { href: 'https://host.example/p', origin: 'https://host.example', pathname: '/p' });

  assert.equal(messageListeners.length, 1, 'content script registers exactly one message listener');
  messageListeners[0]({ type: 'repair-page' }, null, () => {}); // invoke as the worker does

  const leaked = hostTypes.filter((t) => FORBIDDEN_HOST_EVENTS.includes(t));
  assert.deepEqual(leaked, [], `extension must not hook host input events; saw: ${leaked.join(', ')}`);
  cleanupContentGlobals();
});

test("a host input keeps its own paste handler, unprevented, after a repair pass", () => {
  // The input is named (aria-label) so it isn't an unlabeled control — that
  // keeps repairPage on the synchronous deterministic path (no phase-2 round
  // trip resolving after this test tears its globals down). The paste
  // invariant is identical either way.
  const win = parseHTML(
    '<!doctype html><html><body><h1>Title</h1><h3>Skipped level</h3><input id="field" aria-label="Search"></body></html>'
  );
  const d = win.document;
  const messageListeners = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: async () => ({ labels: [] }),
    },
  };
  loadContentScript(d, chromeStub, { href: 'https://host.example/p', origin: 'https://host.example', pathname: '/p' });
  messageListeners[0]({ type: 'repair-page' }, null, () => {});

  const field = d.getElementById('field');
  let hostHandlerRan = false;
  field.addEventListener('paste', () => { hostHandlerRan = true; });
  const ev = new win.Event('paste', { bubbles: true, cancelable: true });
  field.dispatchEvent(ev);

  assert.equal(hostHandlerRan, true, "the host page's own paste handler still fires");
  assert.equal(ev.defaultPrevented, false, 'repair must never preventDefault a host paste');
  cleanupContentGlobals();
});

// ---------------------------------------------------- live-region spine (§4)

// These guard the platform §4 contract that the extension's status surface
// rests on. Every assertion here reads the real DOM the shipped content script
// produced — counting announce() *calls* would pass while a screen reader hears
// nothing, which is the exact failure this suite exists to catch.

console.log('live-region spine (§4)');

// announce() deliberately delays the text write (~300ms for a freshly created
// region) so screen readers register the region before its content mutates.
// Tests must therefore wait out that warm-up rather than assert synchronously.
const ANNOUNCE_SETTLE_MS = 450;
const settle = () => new Promise((r) => setTimeout(r, ANNOUNCE_SETTLE_MS));

const asyncTests = [];
function atest(name, fn) {
  asyncTests.push([name, fn]);
}

function liveRegions(d) {
  return {
    polite: d.getElementById('page-repair-status'),
    assertive: d.getElementById('page-repair-alert'),
  };
}

function contentStub(sendMessage) {
  const messageListeners = [];
  return {
    messageListeners,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        sendMessage,
      },
    },
  };
}

const LOC = { href: 'https://host.example/p', origin: 'https://host.example', pathname: '/p' };

test('both live regions are pre-created at injection, before any message arrives', () => {
  const d = doc('<h1>Title</h1>');
  const stub = contentStub(async () => ({ labels: [] }));
  loadContentScript(d, stub.chrome, LOC);

  // No message has been dispatched — creation must already have happened. A
  // region that first enters the DOM alongside its content gets dropped by
  // screen readers, so lazy creation means the first failure is never spoken.
  const { polite, assertive } = liveRegions(d);
  assert.ok(polite, 'polite region must exist at injection time');
  assert.ok(assertive, 'assertive region must exist at injection time, not on first error');
  assert.equal(polite.getAttribute('role'), 'status');
  assert.equal(polite.getAttribute('aria-live'), 'polite');
  assert.equal(assertive.getAttribute('role'), 'alert');
  assert.equal(assertive.getAttribute('aria-live'), 'assertive');
  assert.equal(polite.textContent, '', 'regions start empty');
  assert.equal(assertive.textContent, '', 'regions start empty');
  cleanupContentGlobals();
});

atest('a success summary speaks politely and leaves the assertive channel silent', async () => {
  const d = doc('<h1>Title</h1><h3>Skipped level</h3><p>body</p>');
  const stub = contentStub(async () => ({ labels: [] }));
  loadContentScript(d, stub.chrome, LOC);
  stub.messageListeners[0]({ type: 'repair-page' }, null, () => {});
  await settle();

  const { polite, assertive } = liveRegions(d);
  assert.match(polite.textContent, /Page repair:/, 'the repair summary lands in the polite region');
  assert.equal(assertive.textContent, '', 'a successful repair must never fire the alert region');
  cleanupContentGlobals();
});

atest('a background failure speaks assertively and does not land in the polite region', async () => {
  // An unnamed button is an ambiguous control, so repairPage proceeds to
  // phase 2 and hits the background worker — which we make fail.
  const d = doc('<h1>Title</h1><button></button>');
  const stub = contentStub(async () => {
    throw new Error('extension context invalidated');
  });
  loadContentScript(d, stub.chrome, LOC);
  stub.messageListeners[0]({ type: 'repair-page' }, null, () => {});
  await settle();

  const { polite, assertive } = liveRegions(d);
  assert.match(
    assertive.textContent,
    /could not label controls/,
    'a genuine failure must route to the assertive region — SC 4.1.3'
  );
  assert.doesNotMatch(
    polite.textContent,
    /could not label controls/,
    'the failure must not also be announced politely (double-read)'
  );
  cleanupContentGlobals();
});

atest('partial progress is NOT a failure — it stays on the polite channel', async () => {
  // 45 unnamed controls exceeds MAX_LABEL_BATCH (40), so repairPage emits the
  // "Labeling 40 of 45 … run repair again for the rest" summary. That is
  // partial progress, not an error, and must not seize the assertive channel.
  //
  // The worker stub never resolves, so phase 2 never announces: that pins the
  // polite region to the phase-1 message we are asserting about. (A stub that
  // resolves instantly races phase 2's ~50ms write against phase 1's ~300ms
  // region warm-up and makes the observed end state order-dependent.)
  const d = doc('<h1>Title</h1>' + '<button></button>'.repeat(45));
  const stub = contentStub(() => new Promise(() => {}));
  loadContentScript(d, stub.chrome, LOC);
  stub.messageListeners[0]({ type: 'repair-page' }, null, () => {});
  await settle();

  const { polite, assertive } = liveRegions(d);
  assert.match(polite.textContent, /run repair again for the rest/, 'partial progress announces politely');
  assert.equal(assertive.textContent, '', 'partial progress must not fire the alert region');
  cleanupContentGlobals();
});

// --------------------------------------------------------------------------

const run = async () => {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (e) {
      console.error(`  FAIL - ${name}\n    ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
};

await run();
