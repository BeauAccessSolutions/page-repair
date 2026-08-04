# Chrome Web Store listing — Page Repair

Copy/paste source for the Web Store developer dashboard. Fields map 1:1 to the
dashboard sections.

---

## Product name
Page Repair

## Summary (max 132 chars — used as the manifest description too)
Fixes broken pages for screen reader users: labels unlabeled controls, repairs headings and landmarks. Always user-invoked.

## Category
Accessibility

## Language
English (United States)

---

## Detailed description

Page Repair fixes the specific things that make websites hard to use with a
screen reader — and it only ever runs when you ask it to.

Press the toolbar button or Alt+Shift+R and Page Repair will:

• Give accessible names to unlabeled buttons and controls, so your screen
  reader announces "Search" instead of "button".
• Repair broken heading structure (skipped or out-of-order levels) so heading
  navigation works.
• Add missing landmarks (like a main region) so you can jump to content.

What makes it different from an accessibility "overlay":

• User-invoked only. It never runs on page load and never runs by itself. It
  uses the activeTab permission, so it can't even see a page until you invoke
  it on that page.
• It patches, it doesn't rewrite. The site's own JavaScript, visuals, and
  interactivity keep working — nothing is stripped or regenerated.
• Fast and local first. Heading and landmark fixes are computed on your device
  in milliseconds. Only genuinely ambiguous unlabeled controls are sent for
  labeling, and only a small slice of surrounding HTML — never the whole page.
• Honest about uncertainty. High-confidence labels are applied; medium-
  confidence ones carry a separate "auto-labeled, unverified" note (announced
  after the label, kept out of the name itself so braille and voice control
  keep working); low-confidence guesses are discarded. A wrong label is worse
  than none.
• Never speaks uninvited and never moves your focus. One polite announcement
  tells you what was actually fixed, only right after you invoked the repair.
• Fully reversible. Alt+Shift+U removes every repair and restores the page's
  original attributes.
• Helps you tell the site. A command copies a plain-language accessibility
  report (with WCAG references) to your clipboard for you to send — the
  extension never contacts anyone on your behalf.

Labeling requires either your own Anthropic API key or a prepaid credit
token — you choose in the options page. See the privacy policy for exactly what
data is sent and when.

## Single purpose (dashboard requires this)
Page Repair has one purpose: when the user invokes it, repair the accessibility
of the current page for screen reader users by adding accessible names, fixing
heading structure, and adding missing landmarks.

---

## Permission justifications

- **activeTab** — Lets the extension access the current tab only at the moment
  the user invokes a repair. This is what keeps it from seeing any page until
  asked.
- **scripting** — Injects the audit-and-repair scripts into the current page
  when the user invokes a repair.
- **storage** — Saves the user's own settings locally (API key or credit
  token, model choice). Never synced by us.
- **notifications** — Used only to say "Page Repair can't run on this page"
  when the user invokes it somewhere extensions can't inject (browser pages,
  the Web Store, PDFs) — the in-page announcement channel doesn't exist there,
  and silence would be indistinguishable from the extension being broken.
- **Host permission `https://api.anthropic.com/*`** — In bring-your-own-key
  mode, the extension calls the Anthropic API directly to label controls.
- **Host permission `https://page-repair-proxy.airboat-webcast-5u.workers.dev/*`**
  — In prepaid-credits mode, the extension calls the Page Repair proxy (this
  exact origin only), which meters credits and forwards the request to
  Anthropic.

## Remote code
No remotely hosted code. All executable code is packaged in the extension. The
network calls above send data to an API and receive JSON (labels); they do not
fetch or run remote code.

## Privacy policy URL
https://github.com/BeauAccessSolutions/page-repair/blob/main/PRIVACY.md

This points at the rendered `PRIVACY.md` in the public canonical repo, which
satisfies the Chrome Web Store's public-URL requirement. Upgrade path: replace
with a dedicated page you control (e.g. on beauaccesssolutions.com) before or
shortly after launch — the store listing can be updated in place.

---

## Graphic assets checklist (must be produced before submitting)

- [x] Store icon 128×128 — `icons/icon128.png`
- [ ] At least 1 screenshot, 1280×800 or 640×400 (PNG/JPEG). Suggested shots:
      before/after of an unlabeled control being named; the options page; the
      results announcement.
- [ ] Small promo tile 440×280 (optional but recommended)
- [ ] Marquee 1400×560 (optional)

Screenshots require running the extension on a real page, so they are the one
asset that can't be generated here — capture them from a Chrome window with the
extension loaded.
