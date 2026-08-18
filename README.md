# Page Repair (prototype)

You tab into a checkout form and your screen reader says "button, button,
button." Someone shipped that page without naming its controls, and you are
the one who can't finish the purchase. Page Repair names them — on your
command, on the page you chose, and it tells you which labels it wasn't sure of.

A user-invoked browser extension that repairs broken web pages for screen
reader users — fixing unlabeled controls, broken heading structure, and
missing landmarks with targeted ARIA patches that keep the page fully alive.

**Not an overlay.** Overlays are site-installed, run automatically, claim
compliance, and are widely hated by the people they claim to serve. This is
the inversion: user-installed, user-invoked, fixes only what it can verify,
and says so honestly.

## Research grounding

Built from a deep-research pass (WebAIM Screen Reader Surveys
[#7](https://webaim.org/projects/screenreadersurvey7/) /
[#10](https://webaim.org/projects/screenreadersurvey10/), the
[Overlay Fact Sheet](https://overlayfactsheet.com/), NFB position statements,
ASSETS 2024/2025 papers) and a close read of "From Cluttered to Clear"
(ASSETS 2025, [arXiv:2502.18701](https://arxiv.org/abs/2502.18701)) — the
closest prior art. Key evidence:

- [85.9% of screen reader users say better *websites* would help more than
  better assistive tech](https://webaim.org/projects/screenreadersurvey10/)
  (WebAIM #10). The top problems are content-authoring failures: unlabeled
  buttons, bad headings, chaotic dynamic content.
- The ASSETS 2025 study proved LLM page restructuring significantly improves
  task times and experience (n=15) — but did it by regenerating the entire
  page as text-only HTML: scripts stripped, visuals destroyed, 220K tokens,
  $0.50–$2.20 and 1–5 minutes per page, applied automatically with no user
  control and no provenance.
- Their own formative participants asked for the opposite: "I prefer browsing
  myself because I can control what I do with my screen reader."

## Design rules (each traceable to user evidence)

1. **User-invoked only** (toolbar / Alt+Shift+R). Never runs on page load.
   Uses `activeTab`, so the extension can't even see a page until asked.
2. **ARIA patches, never rewrites.** Site JavaScript, visuals, and
   interactivity keep working — including for low-vision users who pair
   magnification with a screen reader.
3. **Deterministic first, LLM second.** Heading-level repair and landmark
   fixes are computed locally and applied in milliseconds. Only genuinely
   ambiguous unlabeled controls go to the model — just their local HTML
   context, never the full page.
4. **Confidence-gated labels with provenance.** High-confidence labels apply
   as-is; medium-confidence labels carry an "auto-labeled, unverified" note
   in `aria-description` — after the name, so braille displays and
   voice-control name matching stay clean; low-confidence guesses are
   discarded. A wrong label is worse than none.
5. **Never speak uninvited, never move focus.** One polite live region
   announces what was *actually applied* — never a fix that silently failed
   — only right after the user invoked the repair.
6. **Reversible.** Every patch records the attribute values it replaced;
   Alt+Shift+U restores the original page. If an SPA re-render wipes a
   patch, re-invoking repair is the recovery path — the extension never
   fights the page for its own attributes.
7. **Report, never contact.** A command copies a plain-language audit report
   (WCAG references, heuristic disclaimer) to the clipboard for the *user*
   to send. Automated complaints would poison the reporting channel and
   disclose the user's disability status without their say — so that
   feature is deliberately absent.

## Measured (see `test/latency.mjs`)

| Page | Audit | Findings |
|---|---|---|
| Hacker News (34 KB) | 3.9 ms | 31 unlabeled controls (vote arrows) |
| Craigslist (59 KB) | 5.8 ms | 3 heading repairs, missing main landmark |
| Wikipedia (119 KB) | 2.0 ms | nearly clean (negative control) |

Deterministic fixes land in single-digit milliseconds. LLM labeling is one
structured API call over a pruned context (~2 orders of magnitude fewer
tokens than full-page regeneration).

## Try it

1. `chrome://extensions` → Developer mode → Load unpacked → this folder.
2. Options page → configure labeling (only needed for unnamed controls;
   heading/landmark repair works with no configuration at all):
   - **Prepaid credits.** A credit token routes labeling through the metered
     proxy in [`proxy/`](proxy/README.md); no Anthropic account needed.
   - **Your own API key.** Calls go straight from the browser to Anthropic;
     auditable, nothing passes through our servers. Wins if both are set.
3. On any page: press Alt+Shift+R or click the toolbar button. Alt+Shift+U
   undoes all repairs; a third command (unbound by default — see the options
   page) copies an accessibility report to the clipboard.

Tests: `npm install`, then `npm test` (unit: selector round-trip invariant,
heading repair, accessible names, apply/undo) and `node test/latency.mjs`
(audit timings; `--llm` adds one live labeling call with `ANTHROPIC_API_KEY`).
Fixture regeneration: [`test/README.md`](test/README.md).

## Next

- **Participatory design** — recruit blind co-designers (NVDA/JAWS users
  first: ~78% of primary desktop use) before building further. Nothing about
  us without us. Everything else waits on what testers say.
