## Summary
<!-- what changed and why -->

## Design & accessibility checklist
<!-- BAS UX/a11y standard — canonical: bas-platform/docs/design-principles.md -->
- [ ] Overlay is non-intrusive: does not hijack host-page focus/scroll, does not block host-page paste
- [ ] Patches degrade gracefully if the host page changes; never breaks the page it fixes
- [ ] Every async action has loading / empty / error / success states
- [ ] Touch/click targets ≥ 44/48px hit area
- [ ] Any animation < 300ms AND has a prefers-reduced-motion path
- [ ] Dynamic status (labeling/errors/clipboard) is text/shape, not color/animation alone
- [ ] Failures routed to an assertive (role="alert") live region, pre-created before first message; non-failures polite
- [ ] Contrast ≥ 4.5:1 text / 3:1 large & UI — verified in BOTH light and dark (declare color-scheme)
- [ ] Visible focus everywhere
- [ ] Minimal, clearly-explained permission asks; progressive disclosure

## Testing
<!-- how you verified -->
