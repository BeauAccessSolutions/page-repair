# Page Repair

A user-invoked browser extension (Manifest V3) that repairs accessibility on third-party
pages for screen-reader users — labels unlabeled controls, repairs heading structure, adds
missing landmarks — with targeted ARIA patches that never rewrite the page. See
[README.md](README.md) for the design rules and their evidence, and
[docs/ux/overlay-ux.md](docs/ux/overlay-ux.md) for the overlay/injection UX standard
(anchored to bas-platform `docs/design-principles.md` §2 and §4).

**Non-negotiables** (each traceable to screen-reader-user research): user-invoked only,
ARIA-attribute patches never rewrites, never move focus / scroll / block paste, one polite
live region + one assertive alert region for status, reversible via undo, confidence-gated
labels with provenance in `aria-description` (never the accessible name).

## Platform context — shared accessibility-app platform

This repo is one of a portfolio of accessibility/disability-focused apps by the same
author. Several are converging on a **shared platform**: a standalone, self-hosted
**Keycloak** identity service plus a shared **Expo (React Native + RN Web)** design
system, so those apps share sign-in and UI **without coupling their backends**.

**Canonical guide — read before any cross-app identity / SSO / shared-UI work:**
<https://github.com/BeauAccessSolutions/bas-platform/blob/main/PLATFORM.md>
(invariants in [INVARIANTS.md](https://github.com/BeauAccessSolutions/bas-platform/blob/main/INVARIANTS.md),
decision records under `docs/adr/` in that repo). Canonical home is the
**Beau Access Solutions** governance repo (`BeauAccessSolutions/bas-platform`).

**This app's role: not an identity member.** It's a user-invoked browser extension with
no accounts, so it doesn't federate to Keycloak. It's listed for portfolio awareness —
and its honest, verify-before-claiming ARIA-repair patterns should inform the shared
**`ui` design system**. Treat the invariants below as house style.

**Platform invariants** (house style across the portfolio):
1. **Layered sessions** — an identity token is never itself a data-access credential; sensitive
   apps exchange it for their own revocable, rate-limited session + step-up.
2. **No platform tracking on sensitive pages** — shared UI is telemetry-free; analytics is separate
   and opt-in; each app owns its own CSP.
3. **Decoupled deletion/export** — each app owns its data lifecycle; deletion and export stay
   independently complete.
4. **Contribution boundary** — sensitive backends stay in their own repos behind a review gate;
   shared UI/auth/config stay open.
5. **i18n ownership** — shared UI carries no hardcoded strings; each app owns its catalogs and its
   human-review gate for translated languages.

---
<!-- Shared cross-project lessons. Edit the canonical file, not here. -->
@~/.claude/shared/LESSONS.md
<!-- BAS-platform-only lessons. Canonical file lives in bas-platform. -->
@~/projects/bas-platform/LESSONS.md
