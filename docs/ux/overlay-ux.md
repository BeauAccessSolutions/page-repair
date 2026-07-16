# Overlay & Injection UX — Page Repair

How Page Repair's injected UI and DOM patches must behave on pages it does not
own. This is the app-specific companion to the BAS platform standard
[`bas-platform/docs/design-principles.md`](../../../bas-platform/docs/design-principles.md),
which lists page-repair's highest-value surfaces as **§2 (delight rules)** and
**§4 (accessibility spine)**. This doc tailors those two sections to a Manifest V3
content-script/overlay stack and adds the constraints that only apply when you
are operating on someone else's page.

> **Terminology note.** The [README](../../README.md) is emphatic that Page Repair
> is **"Not an overlay"** — not the site-installed, auto-running, compliance-claiming
> widget that screen-reader users rightly hate. That stays true. In *this* doc
> "overlay UX" means the narrow, honest thing: the few UI surfaces the extension
> injects into or renders over a host page (the live region, the toolbar popup,
> notifications) and the ARIA patches it writes into a DOM it doesn't control. The
> whole point of the rules below is to keep those surfaces from ever becoming the
> overlay the README rejects.

---

## 0. Where this sits in the standard

The platform doc's governing principle — *the highest a11y bar forges the best
design system* — is doubly literal here. Page Repair is the only BAS app whose
**product** is accessibility remediation, and it runs on the open web rather than
our own screens. So two inheritances flow in opposite directions:

- **Down from the standard:** §2's delight-gate rules and §4's dynamic-status
  spine apply to every surface we inject (see §3, §4 below).
- **Up into the standard:** the ARIA patch patterns we prove here (heading-level
  repair, landmark inference, provenance-tagged auto-labels) are candidates to
  graduate into shared [`packages/ui`](../../../bas-platform) primitives (see §7).

Everything below is subordinate to one prime directive.

---

## 1. Prime directive — non-intrusive by default

**Never fight the host page.** The page's focus, scroll position, contrast,
selection, clipboard, and keyboard belong to the page and its user. Page Repair
adds semantics; it does not take control. Every design decision defers to the
host.

This is not a soft preference — it is what separates Page Repair from the overlay
category. The rules:

### 1.1 Never hijack focus
- **Do not move focus, ever.** No `element.focus()`, no `autofocus`, no
  `tabindex` juggling on host nodes, no focus-trapping. `src/apply.js` writes
  ARIA *attributes* only and is explicitly forbidden from touching focus or
  scroll — keep it that way.
- The post-repair announcement is delivered through a **polite live region**
  (`role="status"`, `aria-live="polite"`), which speaks *without* stealing
  focus or interrupting the user's current utterance. See §4.1.
- Any injected chrome (popup, options) lives in the extension's own surface or
  its own document — never a focusable node grafted into the host tab's tab
  order.

### 1.2 Never touch scroll
- No `scrollIntoView`, no scroll listeners that call `preventDefault`, no
  anchoring the viewport to a patched element. The user's reading position is
  sacred. A repair that yanks the viewport is a regression even if the ARIA is
  perfect.

### 1.3 Never block paste — or any host input
- **The host page's clipboard behavior must survive us untouched.** Do not
  register capture-phase `paste`, `copy`, `cut`, `keydown`, or `beforeinput`
  listeners on `document`/`window` that could `preventDefault` or
  `stopPropagation` on the page's own handlers. This matters *doubly* here
  (§5): a paste-swallowing extension breaks the very login and form fields our
  users depend on, on pages we can't test in advance.
- The extension's own commands come in through the browser's command API
  (`Alt+Shift+R`, `Alt+Shift+U`) and `chrome.runtime.onMessage`, **not** through
  DOM key listeners on the host. This is already the architecture in
  `src/content.js` — no `keydown` handler is attached to the page. Preserve that
  boundary: new features get browser commands or extension-surface UI, never a
  global DOM key hook.
- The "copy audit report" command writes to the clipboard **only** in direct
  response to the user invoking it, and only the report text. It never reads the
  clipboard and never intercepts the page's copy/paste.

### 1.4 Never fight the page's contrast or paint
- Page Repair's functional patches are **invisible by design** — they change the
  accessibility tree, not pixels. That is a feature: no contrast can be broken
  because nothing is painted onto the host.
- The one node we do inject, the live region, is **visually hidden** (the
  `clip-path: inset(50%)` / 1×1px pattern in `apply.js`), so it never occludes,
  reflows, or re-contrasts anything.
- **If a future surface ever paints on the host** (e.g. a "patched" indicator):
  it must (a) respect `prefers-color-scheme` and `prefers-contrast`, (b) meet
  §4's ≥4.5:1 / ≥3:1 contrast in *both* themes against an unknown background —
  which in practice means an opaque, self-contained container, never text laid
  directly over host pixels — and (c) sit in a container with a defensive reset
  (see §2.3) so host CSS can't wreck it and it can't leak into the host.

### 1.5 Never speak uninvited
- One announcement, and only right after the user invoked a command. No
  page-load chatter, no periodic re-announcements, no "did you know" nudges.
  The live region says what **actually applied** — never a fix that silently
  failed. This is the §4 status contract; it is also the difference between a
  tool and an intrusion.

---

## 2. Injection safety — degrade gracefully, never break the page

Page Repair's second law: **it must never break the page it is trying to fix.**
A wrong label is worse than none; a broken page is worse than an unrepaired one.
The host page is a live, adversarial, ever-changing environment. Design for it.

### 2.1 Patches are additive, attribute-only, and reversible
- **ARIA attributes only.** Never rewrite HTML, remove nodes, reparent, or touch
  event handlers. Site JavaScript, visuals, and interactivity keep working —
  including for low-vision users pairing magnification with a screen reader.
  This is enforced in `apply.js#applyOne` and must not regress.
- **Every patch records what it replaced.** `applyOne` stores the prior value of
  each attribute (`null` if absent) in a registry so `undoAll` can restore the
  page byte-for-byte. `Alt+Shift+U` is the guaranteed exit.
- **Don't overwrite what the page already set correctly.** `applyOne` only writes
  when the current value differs; a control the site already named is left alone.

### 2.2 Degrade quietly when the DOM doesn't match
- **Selector miss = skip, not throw.** `applyOne` returns `false` when
  `querySelector` finds nothing; `applyPatches` collects only what applied.
  Announcements are computed from `phase.applied`, so we **never announce a fix
  that didn't land** (`content.js`). If the page changed between audit and apply,
  the worst case is "we fixed less than we found," never a crash or a lie.
- **SPA re-render wipes our attributes? Don't fight it.** We never re-assert a
  patch in a mutation-observer loop or race the framework for control of its own
  attributes — that path leads to flicker, infinite loops, and broken diffing.
  The recovery model is deliberately manual: **re-invoke repair.** Document this
  as the intended behavior, not a limitation to "fix."
- Wrap the whole invoked pass so a thrown exception can never leave the host in a
  half-patched state or surface a raw error to the user. A failed repair is a
  no-op plus a plain-language status line, never a stack trace (platform §1
  "Feedback & system status").

### 2.3 Isolate anything you render
- The live region uses inline styles scoped to a single `id` and injects nothing
  else. Any future injected UI must be **isolated from host CSS in both
  directions** so host stylesheets can't restyle our controls and our styles
  can't leak into the page. The sanctioned mount is
  [`src/isolate.js`](../../src/isolate.js) — `PageRepairIsolate.createIsolatedHost(id)`
  returns a namespaced, `data-page-repair`-marked host with an **open shadow
  root** (CSS isolation is identical to closed; open stays debuggable and
  re-findable — see the module header for the decision) whose base reset does
  `:host { all: initial }` plus a `prefers-reduced-motion` / `color-scheme` path.
  Mount visible UI into the returned shadow `root`, never onto a bare host node;
  never rely on class names that could collide with the host. (The live region
  itself deliberately stays an inline-hidden host node — announcement reliability
  beats CSS-isolating an invisible element.)
- Use a namespaced, collision-proof marker for our own nodes/attributes
  (`data-page-repair`, `#page-repair-status`). One marker, easy to find, easy to
  strip on undo.

### 2.4 Confidence gating is an injection-safety mechanism, not just a labeling one
- Deterministic fixes (headings, landmarks) are computed locally and are safe to
  apply immediately. Ambiguous labels go to the model over **pruned local
  context**, and come back **confidence-gated**: high-confidence applies as-is;
  medium-confidence carries provenance (§7.2); low-confidence is **discarded**.
  Refusing to guess is part of not-breaking-the-page: a confident-sounding wrong
  name actively misleads a screen-reader user.

---

## 3. The delight layer (§2), rewritten for a page you don't own

Platform §2 says micro-interactions must feel *earned*, and gives four gate
rules. On a host page, "delight" is not animation and celebration — it's the
quiet competence of a tool that does exactly what it said and then gets out of
the way. Map §2's rules onto that:

| §2 rule | What it means for an injection tool |
|---|---|
| **1. Purpose** — no pure decoration | Every injected effect must *confirm, show status, or guide*. Page Repair's entire "delight" budget is the one honest post-repair summary. No confetti, no toasts stacking, no badge animations on the host. |
| **2. Fast** — <300ms, natural easing | Deterministic fixes land in single-digit milliseconds (measured; see README table) and feel instant. The only intentional delay — the live-region warm-up in `apply.js#announce` — is a *correctness* delay (~300ms so a just-created region registers before it mutates), not an animation. Keep it invisible and never longer than it must be. |
| **3. Don't repeat the surprise** | We announce once per invocation, never on load, never on a timer. Re-invoking is a deliberate user act, so re-announcing then is expected, not a repeated "surprise." |
| **4. `prefers-reduced-motion` is mandatory** | See §5. On a page we don't control this is not a nicety — it's a gate we own doubly. |

**Optimistic UI, honestly.** Platform §2 endorses optimistic UI ("the action
registers instantly"). Page Repair does the honest version: it applies the
instant deterministic fixes and announces *those* immediately (phase 1), then
announces the LLM-labeled controls when they return (phase 2) — but each
announcement reports **only what actually applied**, never an optimistic promise
that might not land. Optimism about the network is fine; optimism about a fix is
a lie to a user who can't see the page.

**No animation on the host, full stop.** The platform's themed transitions and
presence pulses are for *our* surfaces. We do not animate the host page. There is
no reduced-motion path to design for the host because there is no motion to begin
with — which is the safest possible answer to gate rule 4.

---

## 4. Accessibility spine (§4) — dynamic status on a foreign page

Platform §4 identifies dynamic status as the riskiest a11y surface and mandates
**one live-region + reduced-motion utility** that all status routes through.
Page Repair's status surface is exactly one thing — "what the repair did" — and
it must satisfy the full §4 contract.

### 4.1 The live-region contract (already implemented; hold the line)
- **Text, never color or animation alone** (SC 1.4.1, 4.1.3). The summary is a
  plain sentence: *"Page repair: fixed 3 heading levels, added main landmark."*
  No icon-only, no color-only signal.
- **Polite, not assertive, for success** (`aria-live="polite"`, `role="status"`)
  so it queues behind the user's current utterance rather than interrupting.
- **Failures escalate.** Per platform §4, a genuine *failure* (e.g. labeling call
  errored, no credits) should reach the user assertively. Route hard failures to
  an assertive channel (`role="alert"`, or the extension's `notifications`
  permission) — but a *partial* result ("labeled 40 of 60, run again for the
  rest") stays polite. Distinguish "nothing worked" from "more to do."
- **Region must pre-exist its first message.** `apply.js#ensureRegion` creates it
  at injection time and `announce` gives a just-created region ~300ms before
  mutating — because screen readers drop changes to a region that entered the DOM
  in the same breath. This is the debounce/registration discipline §4 calls for;
  do not remove it.
- **Announce once, debounced.** No re-reading on repeat passes; clear-then-set so
  a genuine re-invocation re-fires. Matches §4's "debounce announcements so
  screen readers aren't re-reading on every keystroke."

### 4.2 Provenance without polluting the accessible name
This is Page Repair's original contribution to the spine. Medium-confidence
auto-labels must disclose their uncertainty **without corrupting the name a
screen reader or voice-control user matches against**:

- The label goes in `aria-label`; the disclaimer *"Auto-labeled, unverified"*
  goes in **`aria-description`** (`apply.js#patchesFromIssues`), which announces
  *after* the name, at lower priority, is suppressible via SR verbosity settings,
  stays off braille displays, and doesn't break voice-control name matching.
- Never bake provenance into the accessible name (e.g. `aria-label="Search
  (auto-labeled)"`) — that forces "auto-labeled" into every voice command and
  every braille line. The separation *is* the accessibility design.

### 4.3 Visible focus / contrast (for our surfaces only)
- The options page and popup must meet §4's visible-focus (SC 2.4.11, 2.4.13) and
  ≥4.5:1 / ≥3:1 contrast bars in **both** light and dark, verified with axe. The
  options page uses `system-ui` and semantic controls; keep native focus rings —
  don't `outline: none` anything.
- On the **host** page we assert nothing about focus appearance or contrast
  because we paint nothing (§1.4). If that ever changes, the host surface inherits
  the full §4 bar.

---

## 5. Reduced-motion and never-block-paste — the double-weight constraints

Platform §1 ("never block paste") and §2 gate rule 4 ("`prefers-reduced-motion`
is mandatory") apply to every BAS app. They carry **double weight** here because
we run on pages we don't control and can't pre-test — a violation ships to every
site at once, silently.

### 5.1 Never block paste (hard rule)
- **No global DOM listeners that could `preventDefault`/`stopPropagation` on
  clipboard or key events.** Verified today: `content.js` attaches only a
  `chrome.runtime.onMessage` listener; there is no `document`-level `keydown`,
  `paste`, `copy`, or `beforeinput` hook. This is the correct architecture —
  **every new feature must preserve it.**
- Commands arrive via the browser command API and the background worker, so the
  host's own paste/copy/keyboard handling is never in our call path.
- **Test gate (implemented):** `test/unit.mjs` → *never-block-paste (§5.1)* locks
  this two ways — a **structural** check that a full repair pass registers none of
  `paste`/`copy`/`cut`/`keydown`/`keyup`/`keypress`/`beforeinput` on `document` or
  `window` (loading the real `content.js` source, not a stand-in), and a
  **behavioral** check that a host input's own paste handler still fires and is
  never `defaultPrevented` after a repair. If anyone later adds a global clipboard
  or key hook, the structural test fails.

### 5.2 Reduced motion (hard rule)
- We introduce **zero animation on the host**, which is the strongest possible
  compliance: nothing to reduce. Keep it that way — reject any feature that
  animates host nodes.
- Any motion on **our own** surfaces (options, popup, a future onboarding panel)
  must wrap every transition in `@media (prefers-reduced-motion: reduce)` with a
  no-motion path, and honor `prefers-reduced-motion` from first paint (not via a
  post-load JS toggle that flashes). Reduced-motion is a gate, not a setting.
- The `announce` warm-up delay (§4.1) is **not** motion and is exempt — it's a
  screen-reader registration requirement, invisible, and does not scale with any
  animation preference.

---

## 6. Permissions & onboarding — minimal ask, progressive disclosure

The trust contract starts at the permission prompt. Page Repair's onboarding is
"ask for almost nothing, explain everything, reveal complexity only when needed."

### 6.1 Minimal, purpose-scoped permissions
The `manifest.json` permission set is deliberately small — **treat it as a budget
to defend, not a default to grow:**

| Permission | Why it's the minimum | UX consequence |
|---|---|---|
| `activeTab` | The extension **cannot see any page until the user invokes it** — no page-load access, no background reading. | This *is* the "user-invoked only" promise, enforced by the platform, not just policy. Say so in onboarding. |
| `scripting` | Injects `audit.js`/`apply.js`/`content.js` **on demand** via `executeScript` (see `background.js`), only after invocation, with a `ping` guard so repeat invokes don't stack. | Nothing runs until asked. |
| `storage` | Holds the user's own labeling config (credit token or API key, model choice). | Never any page content. |
| `notifications` | Assertive channel for hard failures the polite live region shouldn't carry (§4.1). | Used sparingly — errors only. |
| `host_permissions` | Scoped to **exactly two hosts** (Anthropic API + the metered proxy) — not `<all_urls>`. | Labeling can reach only those endpoints; the extension has no standing host access to the pages it repairs. |

- **No broad host permission.** The absence of `<all_urls>` is a feature to
  surface, not fine print: the extension has no ambient access to the web.
- Any new permission must earn its place against this table and be explained in
  plain language *before* it's requested.

### 6.2 Progressive disclosure of setup
Onboarding must front-load the free, zero-config path and defer everything else:

1. **Zero-config core, stated first.** Heading and landmark repair run entirely
   on-device, free, with no account and no key. Most of the value needs no setup.
   The options page leads with this sentence — keep it first.
2. **Labeling is opt-in and revealed only when relevant.** The Anthropic-backed
   labeling of unnamed controls is the *only* thing needing configuration, and
   the copy makes that boundary explicit ("only needed for unnamed controls").
3. **Two clearly-explained paths, user's choice**, presented plainly (options
   page): **prepaid credits** (routes through the metered proxy, no Anthropic
   account, prepaid only — nothing auto-renews) **or your own API key** (calls go
   straight to Anthropic, nothing through our servers, auditable). State the
   privacy trade-off of each at the point of choice, not in a separate policy.
4. **Exact data disclosure at the input.** The options page states precisely what
   leaves the browser during labeling: *only the HTML snippets of unnamed
   controls, plus page title and address without query strings — never the full
   page.* Disclosure lives next to the control that triggers the behavior, per
   platform §1 ("show constraints up front, don't spring them as errors").

### 6.3 Onboarding as accessible-first, keyboard-first
- The primary affordances are the toolbar button and `Alt+Shift+R`; the options
  page tells the user how to view and rebind shortcuts
  (`chrome://extensions/shortcuts`, with the copy-paste caveat that extensions
  can't link there). Discoverability without a mandatory tour.
- Secret inputs (credit token, API key) use `type="password"` with an explicit
  **Show** toggle and `autocomplete="off"`, and each has an adjacent **Test**
  button with a `role="status"` result — validate-on-action, errors next to the
  field, per platform §1 forms rules. Support paste into these fields (§5.1) —
  they are exactly the fields users paste long tokens into.
- **No registration wall, ever.** Consistent with platform §3.3's "no
  registration wall": the tool works on first invoke; configuration is a later,
  optional step the user reaches only if they hit an unnamed control.

---

## 7. Feeding the shared `packages/ui` design system

Per platform §5, page-repair's accessibility patches "inform shared `ui`." These
patterns were *born passing* WCAG 2.2 AA on real, broken, third-party pages —
which is exactly the pedigree the platform's governing principle wants. Document
each as a graduation candidate so authored BAS components inherit the fix
**by construction**, never needing the repair.

### 7.1 Candidate primitives to graduate

| Pattern (proven in page-repair) | Source | `packages/ui` candidate | Why it graduates |
|---|---|---|---|
| **Polite live-region utility** with pre-registration warm-up + clear-then-set re-fire + debounce | `apply.js#ensureRegion`/`announce` | The single `packages/ui` live-region + reduced-motion utility that platform §4 already mandates all four dynamic-status types route through. | We built and measured the registration timing (~300ms) and the visually-hidden CSS that every app's status announcements need. This is the reference implementation. |
| **Provenance-tagged accessible name** — value in `aria-label`, uncertainty in `aria-description` | `apply.js#patchesFromIssues` | A `<Field>` / labeling primitive that can attach non-name metadata without polluting the accessible name or braille/voice-control matching. | Any BAS component surfacing machine-generated or low-confidence content (e.g. the Benefits Navigator's AI answers, §5) needs the same name-vs-description discipline. |
| **Heading-level normalization** (compute correct `aria-level`, apply as attribute) | `audit.js` (`heading-structure`) + `apply.js` | Lint/dev-time check + a `<Heading level>` primitive that refuses to emit a skipped level. | Turns a runtime *repair* into an authoring *guarantee* — the platform's "born passing" ideal. |
| **Landmark inference** (detect missing `main`, apply `role="main"`) | `audit.js` (`missing-main`) | Layout primitives (`<AppShell>`/`<Main>`) that emit landmarks by construction. | Same: what page-repair must patch at runtime, `packages/ui` should make impossible to omit. |
| **Confidence-gated content rendering** (high applies, medium discloses, low discarded) | `content.js` labeling flow | A shared convention for rendering model-generated UI content with a disclosure/discard threshold. | Directly reusable by any AI-facing BAS surface; encodes "a wrong label is worse than none" as a component contract. |

### 7.2 How graduation should work
- **Extract, don't fork.** When a pattern moves to `packages/ui`, page-repair
  should consume the shared primitive (where a content-script bundle allows) so
  the two implementations can't drift. Where the extension can't import the React
  primitive, keep the vanilla version and cite the shared one as the spec.
- **Carry the evidence.** Each graduated pattern brings its axe/WCAG SC mapping
  and, where relevant, its measured timing — the platform's design system is
  supposed to inherit patterns *proven* passing, not merely plausible.
- **Feed it back into design-principles.md §4.** The live-region and
  provenance-name patterns are concrete enough to cite directly in the platform
  spine as the canonical implementations.

---

## 8. Definition of done (acceptance checklist)

A change to any injected surface or patch path ships only if:

- [ ] **Focus:** no code moves focus, sets `autofocus`, or alters host `tabindex`.
- [ ] **Scroll:** no code scrolls the host or anchors the viewport.
- [ ] **Paste/keys:** no `document`/`window`-level `paste`/`copy`/`cut`/`keydown`/
      `beforeinput` listener on the host; the host fixture's own paste handler
      still fires after a repair pass (regression test green).
- [ ] **Additive & reversible:** patches are ARIA-attribute-only; every changed
      attribute's prior value is recorded; `Alt+Shift+U` restores the page exactly.
- [ ] **Degrade, don't break:** selector misses skip silently; a thrown error
      leaves the host untouched and surfaces plain-language status, never a trace;
      announcements report only fixes that *actually applied*.
- [ ] **No host paint / no host motion:** functional patches remain invisible;
      any surface that does paint respects `prefers-color-scheme`,
      `prefers-contrast`, `prefers-reduced-motion`, is CSS-isolated (shadow root /
      iframe), and meets §4 contrast in both themes.
- [ ] **Status contract (§4):** one polite live region, pre-registered before
      first message, text-not-color, debounced; hard failures escalate to an
      assertive channel; partial results stay polite.
- [ ] **Provenance:** any machine-generated label keeps the disclaimer in
      `aria-description`, never in the accessible name.
- [ ] **Permissions:** no new permission beyond the defended set without a
      plain-language, pre-request explanation; no `<all_urls>`.
- [ ] **Onboarding:** zero-config core works on first invoke; any setup is
      progressively disclosed with data-flow stated at the point of input; no
      registration wall.
- [ ] **Own surfaces pass axe** (options/popup) in light and dark, with visible
      focus and ≥4.5:1 / ≥3:1 contrast.
- [ ] **Graduation noted:** any newly proven patch pattern is recorded in §7 as a
      `packages/ui` candidate.

---

## References

- BAS platform standard: [`bas-platform/docs/design-principles.md`](../../../bas-platform/docs/design-principles.md)
  — §2 (delight rules), §4 (accessibility spine), §5 (per-app table).
- Page Repair design rules and research grounding: [README](../../README.md).
- Implementation touchpoints: [`src/apply.js`](../../src/apply.js) (patch/undo,
  live region, provenance), [`src/content.js`](../../src/content.js) (invoked
  flow, announce-what-applied), [`src/audit.js`](../../src/audit.js) (issue
  kinds), [`src/background.js`](../../src/background.js) (on-demand injection,
  `activeTab`), [`manifest.json`](../../manifest.json) (permission budget),
  [`src/options.html`](../../src/options.html) (progressive-disclosure onboarding).
- Privacy posture: [PRIVACY.md](../../PRIVACY.md); store framing:
  [STORE_LISTING.md](../../STORE_LISTING.md).
