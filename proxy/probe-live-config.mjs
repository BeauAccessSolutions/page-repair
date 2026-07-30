#!/usr/bin/env node
// VENDORED COPY — canonical source: ~/.claude/skills/wrangler/probe_live_config.mjs
//
// It lives here because CI must run it and a GitHub runner has no ~/.claude. The skill
// copy is the template; this copy is what actually gates the deployed proxy. They are two
// files, which is the very duplication this probe exists to police — so when you change
// one, re-copy, and re-run ~/.claude/skills/wrangler/tests/test_probe_live_config.sh.
// probe_live_config.mjs — prove a wrangler config is ACTUALLY IN EFFECT in production.
//
// WHY THIS EXISTS
//   Cloudflare does not reject a config it cannot use — it SKIPS it. A Pages
//   `wrangler.jsonc` missing `pages_build_output_dir` is passed over with one build-log
//   line and the site keeps running on dashboard settings. On disabilitywiki.org that hid
//   for weeks, because the file's `vars` duplicated the dashboard's WITH IDENTICAL VALUES:
//   three surfaces agreed with the wrong story (the committed file, the dashboard's
//   file-*detection* banner, and green CI) while only the build log and
//   deployment→Functions→Bindings were honest. Nothing broke until a D1 binding existed in
//   only one of the two sources — and then the endpoint that needed it returned 503.
//
//   The lesson written from that ("Config that is *ignored* rather than *rejected* sends
//   you debugging its contents forever") named its own missing fix: a post-deploy probe
//   asserting a binding-backed endpoint is not 503. This is that probe, generalised —
//   because "not 503" turned out to be too weak on its own. See DESIGN below.
//
// DESIGN — three things this does that a naive health check does not
//
//   1. ASSERTS AGAINST THE CONFIG FILE'S OWN VALUES, not against a hardcoded expectation.
//      Probe expectations interpolate `${VAR}` from the config's `vars` block, so the
//      assertion is literally "production reflects what THIS FILE declares". That is the
//      lesson's "diff the two sources" remedy, executed mechanically against the only
//      honest surface — production behaviour. A skipped config whose dashboard twin holds
//      DIFFERENT values fails here. (A skipped config whose twin holds IDENTICAL values
//      still passes, and that is correct: the env really did reach the runtime. What was
//      dangerous was never the duplication, it was the divergence.)
//
//   2. TREATS A PLAUSIBLE STATUS AS A FAILURE. The signature of "the Function never got
//      its env" is frequently NOT 503. On disability-wiki `/api/auth/login` answers 404
//      "sign-in is not configured" — a status a `status < 500` health check sails past
//      while sign-in is dead for every user. So every probe declares the status and the
//      response CONTENT it expects; 503 and 404 merely get extra diagnosis attached.
//
//   3. REFUSES TO VERIFY AGAINST A PREVIEW. `wrangler pages dev`, a static server and
//      *.pages.dev previews all serve unrewritten origin bytes with zone features off, so
//      a green run there proves nothing about production. Non-production origins are
//      rejected unless --allow-preview is passed explicitly.
//
//   Plus a coverage check: every binding and var the config declares should be claimed by
//   at least one probe (`proves`). An unproven binding is reported — that is the D1 case,
//   where a declared binding sat unexercised until a user found it.
//
// USAGE
//   node probe_live_config.mjs <manifest.json> [--allow-preview] [--json]
//
// EXIT CODES — the three answers are distinct on purpose. A guard must tell the truth in
// both directions: never swallow a real failure, never manufacture a false one.
//   0  every probe passed          1  a probe FAILED (config is not in effect)
//   2  COULD NOT VERIFY (network/DNS/manifest error) — explicitly NOT a pass
//
// MANIFEST
//   {
//     "config": "site/wrangler.jsonc",     // relative to the manifest file
//     "kind":   "pages" | "worker",
//     "origin": "https://example.org",     // production hostname
//     "probes": [{
//       "name": "human description",
//       "path": "/api/auth/login",
//       "method": "GET",                   // default GET
//       "headers": { "content-type": "application/json" },
//       "body": "{}",
//       "expectStatus": 302,
//       "expectHeaderContains": { "location": ["${KEYCLOAK_ISSUER}/protocol/openid-connect/auth"] },
//       "expectBodyContains": ["some string"],
//       "proves": ["KEYCLOAK_ISSUER", "TOKENS"],   // vars and/or bindings this exercises
//       "whenMissing": "what this looks like when the config is inert"
//     }]
//   }
//   Interpolation: ${VAR} and ${VAR:urlencoded} read the CONFIG's vars block.
//   Never put a secret in a manifest; probes assert on shape, not on secret values.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const ALLOW_PREVIEW = args.includes('--allow-preview');
const AS_JSON = args.includes('--json');
const manifestArg = args.find((a) => !a.startsWith('--'));

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_UNVERIFIED = 2;

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

if (!manifestArg) {
  die(EXIT_UNVERIFIED,
    'usage: node probe_live_config.mjs <manifest.json> [--allow-preview] [--json]');
}

/**
 * Strip // and /* *​/ comments from JSONC without corrupting string literals.
 * Both wrangler configs on this machine are heavily commented, and a naive
 * regex would eat a `//` inside a URL — which is every https:// value.
 */
function stripJsonc(text) {
  let out = '', inStr = false, quote = '', inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // tolerate trailing commas, which wrangler accepts
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// ---------------------------------------------------------------- load + static checks

let manifest, manifestPath, config, configPath;
try {
  manifestPath = resolve(process.cwd(), manifestArg);
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  configPath = resolve(dirname(manifestPath), manifest.config);
  config = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8')));
} catch (err) {
  die(EXIT_UNVERIFIED, `✗ COULD NOT VERIFY — manifest/config unreadable: ${err.message}`);
}

const origin = String(manifest.origin || '').replace(/\/+$/, '');
let host;
try {
  host = new URL(origin).hostname;
} catch {
  die(EXIT_UNVERIFIED, `✗ COULD NOT VERIFY — manifest origin is not a URL: ${origin || '(none)'}`);
}
const isLoopback = /^localhost$|^127\./.test(host);
// Production must be https. Plain http is tolerated ONLY for a loopback fixture under
// --allow-preview, which is the flag that already means "I know this is not production".
if (!/^https:\/\//.test(origin) && !(isLoopback && ALLOW_PREVIEW)) {
  die(EXIT_UNVERIFIED,
    `✗ COULD NOT VERIFY — manifest origin must be https, got ${origin}.\n` +
    '  (http is accepted only for a 127.0.0.1/localhost fixture under --allow-preview.)');
}
// *.pages.dev / *.workers.dev are usually a preview — but for a Worker with no custom
// domain, <name>.workers.dev IS production (page-repair's extension calls exactly that
// host). So the manifest can assert it, in writing, and the reason is printed into the CI
// log. A flag on a command line hides; a sentence in the committed manifest does not.
const canonicalReason = typeof manifest.originIsCanonical === 'string'
  ? manifest.originIsCanonical.trim() : '';
const isPreviewHost = /\.pages\.dev$|\.workers\.dev$/.test(host);
if ((isLoopback || isPreviewHost) && !ALLOW_PREVIEW && !(isPreviewHost && canonicalReason)) {
  die(EXIT_UNVERIFIED,
    `✗ COULD NOT VERIFY — ${host} looks like a preview/local origin.\n` +
    '  wrangler pages dev, a static server and per-deploy *.pages.dev previews all serve\n' +
    '  unrewritten origin bytes with the zone features OFF, so a green run there proves\n' +
    '  nothing about production.\n' +
    '  If this host really IS production (a Worker with no custom domain is reached at\n' +
    '  <name>.workers.dev), say so in the manifest and the reason will be printed here:\n' +
    '      "originIsCanonical": "no custom domain — the extension calls this host directly"\n' +
    '  For a genuinely throwaway run, pass --allow-preview.');
}

const findings = [];   // static observations, not per-probe
const vars = config.vars || {};

// The literal trap this file was written for.
if ((manifest.kind || '').toLowerCase() === 'pages' && !('pages_build_output_dir' in config)) {
  findings.push(
    `${configPath} declares no "pages_build_output_dir" and the manifest calls this a Pages\n` +
    '    project. Cloudflare SKIPS such a file rather than rejecting it — one build-log line,\n' +
    '    then the site runs on dashboard settings. The probes below still test what is TRUE in\n' +
    '    production, so if they pass, the runtime env is right either way; what they cannot\n' +
    '    tell you is WHICH SOURCE supplied it. To settle that, put a value in this file that\n' +
    '    exists nowhere in the dashboard and assert it here — identical values on both sides\n' +
    '    are exactly what kept this invisible for weeks.'
  );
}

const declaredBindings = [
  ...(config.kv_namespaces || []).map((b) => b.binding),
  ...(config.d1_databases || []).map((b) => b.binding),
  ...(config.r2_buckets || []).map((b) => b.binding),
  ...(config.queues?.producers || []).map((b) => b.binding),
  ...(config.durable_objects?.bindings || []).map((b) => b.name),
  ...(config.services || []).map((b) => b.binding),
  ...(config.hyperdrive || []).map((b) => b.binding),
  ...(config.vectorize || []).map((b) => b.binding),
  ...(config.ai ? ['AI'] : []),
].filter(Boolean);

const probes = Array.isArray(manifest.probes) ? manifest.probes : [];
if (!probes.length) {
  die(EXIT_UNVERIFIED, '✗ COULD NOT VERIFY — manifest declares no probes.');
}

const proven = new Set(probes.flatMap((p) => p.proves || []));
const unproven = [...declaredBindings, ...Object.keys(vars)].filter((n) => !proven.has(n));

// ------------------------------------------------------------------------ interpolation

function interpolate(template) {
  return String(template).replace(/\$\{(\w+)(?::(urlencoded))?\}/g, (whole, name, filter) => {
    if (!(name in vars)) {
      throw new Error(`probe references \${${name}} but the config's vars declare no ${name}`);
    }
    return filter === 'urlencoded' ? encodeURIComponent(vars[name]) : vars[name];
  });
}

// ------------------------------------------------------------------------------ probing

function diagnose(status, probe) {
  if (status === 503) {
    return 'HTTP 503 is the signature of a DECLARED BINDING THAT DID NOT RESOLVE at runtime:\n' +
           '      the code references env.<BINDING>, the config declares it, and the deployed\n' +
           '      version never received it. Check deployment → Functions/Settings → Bindings\n' +
           '      against the config file, and the BUILD LOG for a line saying the config was\n' +
           '      skipped — the dashboard\'s file-detection banner is not evidence it was read.';
  }
  if (status === 404) {
    return 'HTTP 404 here is the dangerous case: it is what a Function returns when its env\n' +
           '      never arrived (disability-wiki\'s /api/auth/login answers 404 "sign-in is not\n' +
           '      configured"), and it is ALSO what static asset handling returns when the\n' +
           '      Function did not deploy at all. Either way the config is not in effect, and a\n' +
           '      health check asserting only `status < 500` would have called this green.';
  }
  if (status === 200 && probe.expectStatus !== 200) {
    return 'A 200 where the Function should have answered usually means static asset handling\n' +
           '      served the path — the Function is not deployed.';
  }
  return null;
}

async function runProbe(probe) {
  const url = `${origin}${probe.path}`;
  const init = {
    method: probe.method || 'GET',
    redirect: 'manual',              // a 302 IS the assertion; never follow it
    cache: 'no-store',
    headers: probe.headers || {},
  };
  if (probe.body !== undefined) init.body = probe.body;

  let res, bodyText;
  try {
    res = await fetch(url, init);
    bodyText = await res.text();
  } catch (err) {
    return { state: 'unverified', reason: `network error reaching ${url}: ${err.message}` };
  }

  const problems = [];

  if (probe.expectStatus !== undefined && res.status !== probe.expectStatus) {
    problems.push(`expected HTTP ${probe.expectStatus}, got ${res.status}`);
  }

  for (const [header, needles] of Object.entries(probe.expectHeaderContains || {})) {
    const actual = res.headers.get(header) ?? '';
    for (const raw of needles) {
      const needle = interpolate(raw);
      if (!actual.includes(needle)) {
        problems.push(
          `response header "${header}" does not contain the value this config declares:\n` +
          `        want substring: ${needle}\n` +
          `        got header:     ${actual || '(absent)'}`);
      }
    }
  }

  for (const raw of probe.expectBodyContains || []) {
    const needle = interpolate(raw);
    if (!bodyText.includes(needle)) {
      problems.push(
        `response body does not contain: ${needle}\n` +
        `        got (first 200 chars): ${bodyText.slice(0, 200).replace(/\n/g, ' ')}`);
    }
  }

  return problems.length
    ? { state: 'fail', status: res.status, problems, diagnosis: diagnose(res.status, probe) }
    : { state: 'pass', status: res.status };
}

// --------------------------------------------------------------------------------- main

const results = [];
for (const probe of probes) {
  let result;
  try {
    result = await runProbe(probe);
  } catch (err) {
    result = { state: 'fail', problems: [err.message] };   // e.g. unknown ${VAR}
  }
  results.push({ probe, result });
}

const failed = results.filter((r) => r.result.state === 'fail');
const unverified = results.filter((r) => r.result.state === 'unverified');

if (AS_JSON) {
  console.log(JSON.stringify({
    origin, config: configPath, declaredBindings, unproven,
    findings,
    results: results.map(({ probe, result }) => ({ name: probe.name, ...result })),
  }, null, 2));
}

if (!AS_JSON) {
  console.log(`live-config probe → ${origin}`);
  console.log(`  config: ${configPath}`);
  if (isPreviewHost && canonicalReason) {
    console.log(`  origin asserted canonical: ${canonicalReason}`);
  }
  if (declaredBindings.length) console.log(`  bindings declared: ${declaredBindings.join(', ')}`);
  console.log('');
  for (const { probe, result } of results) {
    const mark = result.state === 'pass' ? '✓' : result.state === 'unverified' ? '?' : '✗';
    console.log(`  ${mark} ${probe.name}  [${probe.method || 'GET'} ${probe.path}` +
                `${result.status ? ` → ${result.status}` : ''}]`);
    for (const p of result.problems || []) console.log(`      ${p}`);
    if (result.reason) console.log(`      ${result.reason}`);
    if (result.diagnosis) console.log(`      ${result.diagnosis}`);
    if (result.state === 'fail' && probe.whenMissing) {
      console.log(`      expected-when-inert: ${probe.whenMissing}`);
    }
  }
  if (findings.length) {
    console.log('\n  static findings:');
    for (const f of findings) console.log(`  !   ${f}`);
  }
  if (unproven.length) {
    console.log(`\n  ! declared but exercised by no probe: ${unproven.join(', ')}`);
    console.log('    A declared-and-unexercised binding is precisely how the D1 case reached a');
    console.log('    user: it was correct in the file and absent at runtime, and nothing looked.');
  }
}

if (unverified.length) {
  console.error(`\n✗ COULD NOT VERIFY — ${unverified.length} probe(s) could not reach ${origin}.`);
  console.error('  This is NOT a pass. Re-run when the host is reachable.');
  process.exit(EXIT_UNVERIFIED);
}
if (failed.length) {
  console.error(`\n✗ ${failed.length} of ${results.length} probe(s) FAILED — the config at`);
  console.error(`  ${configPath}`);
  console.error(`  is not in effect at ${origin}. Stop editing its CONTENTS and ask whether it is`);
  console.error('  read at all: check the BUILD LOG for a "skipped" line, then diff this file');
  console.error('  against the dashboard. Equal values are what keeps this invisible.');
  process.exit(EXIT_FAIL);
}
console.log(`\n✓ ${results.length} probe(s) passed — ${configPath} is in effect at ${origin}.`);
process.exit(EXIT_PASS);
