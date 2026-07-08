# Page Repair — Privacy Policy

_Last updated: 2026-07-08_

Page Repair is a browser extension that repairs the page you are currently
viewing for screen reader users. This policy explains exactly what it does and
does not do with your data. It is written to match how the extension actually
behaves — see the source at
https://github.com/Beaudoin0zach/page-repair.

## The short version

- The extension does **nothing** until you invoke it (toolbar button or
  Alt+Shift+R). It cannot see any page until you ask it to repair that page.
- Most repairs (heading and landmark fixes) happen **entirely on your device**.
  No data leaves your browser for those.
- Only genuinely unlabeled controls that can't be resolved locally are sent for
  labeling — and only a small slice of surrounding HTML, never the whole page.
- We do **not** sell your data, show ads, track you across sites, or build a
  profile. There is no analytics or telemetry in the extension.

## What is stored on your device

The extension keeps a small amount of configuration in `chrome.storage.local`
(local to your browser, never synced by us):

- Your personal Anthropic API key, **or** your prepaid credit token —
  whichever labeling mode you choose.
- Your model preference and (optionally) a custom proxy URL.

These never leave your device except to authenticate the labeling request you
explicitly triggered.

## What leaves your device, and when

Data leaves your device **only** when you invoke a repair **and** the page
contains unlabeled controls that need model labeling. In that case the
extension sends, for each unlabeled control:

- a CSS selector for the control,
- a small snippet of the control's surrounding HTML (its local context),
- the page title and page URL.

It does **not** send the full page, its text content, form values, cookies,
your browsing history, or anything from other tabs.

### Two labeling modes

1. **Bring-your-own-key.** If you configure a personal Anthropic API key, the
   labeling request goes **directly from your browser to Anthropic**
   (`api.anthropic.com`). It never touches our servers. That request is
   governed by your own agreement with Anthropic.

2. **Prepaid credits (credit token).** If you use a credit token instead,
   the request goes to our proxy (`*.workers.dev`), which forwards it to
   Anthropic using a server-held key and deducts one credit. The proxy:
   - stores only a **SHA-256 hash** of your token plus a remaining-credit
     count — never the token itself and never page content;
   - logs only aggregate counts (number of controls, model token usage,
     credits remaining) for operating the service — **not** the page URL,
     HTML, or generated labels.

In both modes, prompts sent to the Anthropic API are handled under Anthropic's
terms; Anthropic does not train its models on API traffic by default. See
https://www.anthropic.com/legal.

## What we do not collect

No analytics, no advertising identifiers, no cross-site tracking, no sale or
sharing of personal data, no location data, no keystroke logging.

## Chrome Web Store data disclosures

For the store's data-use form, the extension:

- **Does** handle "Website content" — limited to selectors, small HTML
  snippets, page title, and page URL of the page you actively repair, sent
  solely to perform the labeling you requested.
- Does **not** collect: personally identifiable information, health, financial,
  authentication, personal communications, location, web history, or user
  activity for any purpose other than the single labeling request.
- Data is **not** sold or transferred to third parties except the AI provider
  (Anthropic) strictly to fulfill the labeling request.
- Data is **not** used for purposes unrelated to the extension's single
  purpose, and **not** used for creditworthiness or lending.

## Contact

Questions or requests: open an issue at
https://github.com/Beaudoin0zach/page-repair/issues.
