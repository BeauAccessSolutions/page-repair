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

---
<!-- Shared cross-project lessons. Edit the canonical file, not here. -->
@~/.claude/shared/LESSONS.md
<!-- BAS-platform-only lessons. Canonical file lives in bas-platform. -->
@~/projects/bas-platform/LESSONS.md
