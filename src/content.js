/*
 * Orchestrator. Runs ONLY when the user invokes it (toolbar button or
 * keyboard shortcut) — never automatically on page load.
 *
 * Commands:
 *   repair-page       1. Audit the page (fast, local).
 *                     2. Apply deterministic fixes immediately (headings,
 *                        landmarks) and announce what actually applied.
 *                     3. Send ambiguous unlabeled controls to the background
 *                        worker for LLM labeling; apply those patches when
 *                        they come back and announce again.
 *   undo-repairs      Restore every patched attribute to its original value.
 *   copy-audit-report Copy a plain-language audit report (with WCAG
 *                     references) to the clipboard for the user to send to
 *                     the site owner — always user-initiated, never sent
 *                     anywhere automatically.
 *
 * All timings are collected and logged so latency can be measured in situ.
 */

// Match the background worker's per-request cap so announcements tell the
// truth about how many controls this pass will label.
const MAX_LABEL_BATCH = 40;

// The most recent pre-repair audit, kept for the report so it documents the
// page as the site shipped it, not our patched version.
let lastAudit = null;

// Create both live regions now, at injection time: a region that enters the
// DOM in the same breath as its first message gets dropped by screen readers,
// so the assertive failure channel must be warm before the first failure too.
PageRepairApply.ensureRegion('polite');
PageRepairApply.ensureRegion('assertive');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Injection guard: lets the background worker detect an already-injected
  // content script so repeat invocations don't stack duplicate listeners.
  if (msg.type === 'ping') sendResponse('pong');
  if (msg.type === 'repair-page') repairPage();
  if (msg.type === 'undo-repairs') undoRepairs();
  if (msg.type === 'copy-audit-report') copyAuditReport();
});

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function repairPage() {
  const t0 = performance.now();
  const { issues, auditMs } = PageRepairAudit.run(document);
  if (!lastAudit) {
    lastAudit = { issues, url: location.href, title: document.title, when: new Date() };
  }

  const deterministic = issues.filter((i) => !i.needsLlm);
  const ambiguous = issues.filter((i) => i.needsLlm);
  const batch = ambiguous.slice(0, MAX_LABEL_BATCH);

  // Phase 1: instant fixes. Counts come from patches that actually applied —
  // never announce a fix that didn't happen.
  const phase1Patches = PageRepairApply.patchesFromIssues(deterministic);
  const phase1 = PageRepairApply.applyPatches(phase1Patches);

  const headingFixes = phase1.applied.filter((p) => p.attrs['aria-level']).length;
  const landmarkFixes = phase1.applied.filter((p) => p.attrs.role === 'main').length;

  const fixed = [];
  if (headingFixes) fixed.push(`fixed ${plural(headingFixes, 'heading level')}`);
  if (landmarkFixes) fixed.push('added main landmark');

  let summary;
  if (batch.length > 0) {
    const labeling =
      batch.length < ambiguous.length
        ? `Labeling ${batch.length} of ${plural(ambiguous.length, 'unnamed control')} — run repair again for the rest…`
        : `Labeling ${plural(batch.length, 'unnamed control')}…`;
    summary = fixed.length ? `Page repair: ${fixed.join(', ')}. ${labeling}` : `Page repair: ${labeling}`;
  } else if (fixed.length) {
    summary = `Page repair: ${fixed.join(', ')}.`;
  } else {
    summary = 'Page repair: nothing to fix — headings and landmarks look good.';
  }
  PageRepairApply.announce(summary);

  console.log('[page-repair] phase 1', {
    auditMs: Math.round(auditMs),
    applyMs: Math.round(phase1.applyMs),
    headingFixes,
    landmarkFixes,
    ambiguousControls: ambiguous.length,
  });

  // Phase 2: LLM labels for ambiguous controls.
  if (batch.length === 0) return;

  const tLlm = performance.now();
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'label-controls',
      issues: batch.map((i) => ({ selector: i.selector, context: i.context })),
      pageTitle: document.title,
      // Origin + path only: query strings and fragments routinely carry
      // tokens and personal data the model has no need for.
      pageUrl: location.origin + location.pathname,
    });
  } catch (e) {
    PageRepairApply.announce('Page repair: could not label controls (extension error).', 'assertive');
    console.error('[page-repair] background error', e);
    return;
  }
  const llmMs = performance.now() - tLlm;

  if (response?.error) {
    PageRepairApply.announce(`Page repair: could not label controls. ${response.error}`, 'assertive');
    console.warn('[page-repair] labeling failed:', response.error);
    return;
  }

  const labels = new Map();
  for (const item of response?.labels || []) {
    // Confidence gate: a wrong label is worse than no label. Medium
    // confidence applies with provenance (in aria-description, so the
    // accessible name stays clean); low confidence is discarded.
    if (item.confidence === 'high') {
      labels.set(item.selector, { label: item.label });
    } else if (item.confidence === 'medium') {
      labels.set(item.selector, { label: item.label, unverified: true });
    }
  }

  const phase2Patches = PageRepairApply.patchesFromIssues(
    batch.filter((i) => labels.has(i.selector)),
    labels
  );
  const phase2 = PageRepairApply.applyPatches(phase2Patches);
  const labeled = phase2.applied.length;
  const unverified = phase2.applied.filter((p) => p.attrs['aria-description']).length;

  let done = `Page repair complete: labeled ${labeled} of ${plural(batch.length, 'control')}.`;
  if (unverified > 0) done += ` ${unverified} of those are unverified guesses.`;
  PageRepairApply.announce(done);

  console.log('[page-repair] phase 2', {
    llmMs: Math.round(llmMs),
    labeled,
    unverified,
    skippedLowConfidence: batch.length - labels.size,
    totalMs: Math.round(performance.now() - t0),
  });
}

function undoRepairs() {
  const restored = PageRepairApply.undoAll();
  PageRepairApply.announce(
    restored > 0
      ? `Page repairs removed: ${plural(restored, 'element')} restored to the original page.`
      : 'Page repair: nothing to undo.'
  );
}

// Build a plain-language audit report the user can paste into an email or a
// site's feedback form. Local only: nothing is sent anywhere. Reports the
// page as the site shipped it (the audit taken before any repairs), or a
// fresh audit if repair hasn't been run.
async function copyAuditReport() {
  const audit =
    lastAudit || { issues: PageRepairAudit.run(document).issues, url: location.href, title: document.title, when: new Date() };

  const controls = audit.issues.filter((i) => i.kind === 'unlabeled-control');
  const headingIssue = audit.issues.find((i) => i.kind === 'heading-structure');
  const missingMain = audit.issues.find((i) => i.kind === 'missing-main');

  const url = new URL(audit.url);
  const lines = [
    `# Accessibility findings — ${audit.title || url.hostname}`,
    '',
    `- Page: ${url.origin}${url.pathname}`,
    `- Checked: ${audit.when.toISOString().slice(0, 10)}`,
    `- Method: automated heuristic scan (Page Repair browser extension)`,
    '',
  ];

  if (controls.length === 0 && !headingIssue && !missingMain) {
    lines.push('No issues found by this scan. (The scan covers unnamed controls, heading structure, and the main landmark only.)');
  } else {
    lines.push('## Findings', '');
    if (controls.length > 0) {
      lines.push(
        `### ${plural(controls.length, 'interactive control')} with no accessible name`,
        '',
        'Screen reader users hear only "button" or "link" for these. WCAG 2.1 SC 4.1.2 (Name, Role, Value).',
        ''
      );
      for (const c of controls.slice(0, 15)) {
        lines.push(`- \`${c.context.tag}\` at \`${c.selector}\``);
      }
      if (controls.length > 15) lines.push(`- …and ${controls.length - 15} more`);
      lines.push('');
    }
    if (headingIssue) {
      lines.push(
        `### Heading levels skip (${plural(headingIssue.repairs.length, 'jump')})`,
        '',
        'Skipped heading levels break outline navigation. WCAG 2.1 SC 1.3.1 (Info and Relationships).',
        ''
      );
      for (const r of headingIssue.repairs.slice(0, 10)) {
        lines.push(`- "${r.text}" is level ${r.from}, expected ${r.to}`);
      }
      lines.push('');
    }
    if (missingMain) {
      lines.push(
        '### No main landmark',
        '',
        'Without `<main>` or `role="main"`, screen reader users cannot jump past repeated content to the page body. WCAG 2.1 SC 1.3.1; related to SC 2.4.1 (Bypass Blocks).',
        ''
      );
    }
  }

  lines.push(
    '---',
    'Generated by an automated heuristic scan invoked by a user of this page. Findings should be verified by hand against WCAG 2.1 before being cited; automated checks can both miss and overstate issues.'
  );

  const report = lines.join('\n');
  try {
    await navigator.clipboard.writeText(report);
    PageRepairApply.announce('Accessibility report copied to clipboard. Paste it into an email or feedback form.');
  } catch {
    console.log('[page-repair] report (clipboard unavailable):\n' + report);
    PageRepairApply.announce('Could not access the clipboard. The report was printed to the browser console instead.', 'assertive');
  }
}
