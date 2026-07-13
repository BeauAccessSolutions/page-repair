/*
 * Isolated-container utility for any *visible* UI the extension renders over a
 * host page — a future "patched" badge, an onboarding panel, a settings popover.
 * Implements overlay-ux.md §2.3: injected UI must be isolated from host CSS in
 * BOTH directions, so host stylesheets can't restyle our controls and our styles
 * can't leak into the page.
 *
 * NOT used for the live region. That stays an inline-hidden node in the host DOM
 * (apply.js) on purpose: announcement reliability across screen readers beats
 * CSS-isolating an invisible element, and there is nothing visible to protect.
 * This utility is loaded on demand by whatever feature first renders visible UI —
 * add 'src/isolate.js' to that feature's executeScript list, not before.
 *
 * Isolation mechanism:
 *   - a namespaced host element (collision-proof id + the data-page-repair marker
 *     every injected node carries, so undo/cleanup can find it).
 *   - a shadow root in OPEN mode. CSS isolation is identical to closed; the real
 *     decision is open (the doc floats "closed"). Closed buys nothing here — the
 *     id + marker already prevent host-JS collisions — and it would force us to
 *     stash the root reference to ever touch our own content again. Open stays
 *     debuggable and re-findable.
 *   - `:host { all: initial }` resets the host element's own computed values, so
 *     the inherited properties that DO pierce the shadow boundary (color, font,
 *     line-height…) carry initials into our tree instead of the host's cascade.
 *     Our base then sets a known baseline and, per §1.4 / §5.2, honors
 *     prefers-color-scheme (never fight host contrast) and prefers-reduced-motion
 *     (never animate for a user who opted out).
 */

const PageRepairIsolate = (() => {
  // Kept as a named export so a test can assert the reduced-motion and
  // all-initial rules are present — a prose invariant with a mechanical check.
  const BASE_STYLE = `
    :host { all: initial; color-scheme: light dark; }
    :host, :host * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    @media (prefers-reduced-motion: reduce) {
      :host, :host * {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    }
  `;

  // Create (or reuse) an isolated host for `id`. Returns { host, root, reused }.
  // Mount your UI into `root` (the shadow root), never into `host` directly.
  function createIsolatedHost(id) {
    let host = document.getElementById(id);
    // attachShadow throws if called twice, so an already-hosted node is reused
    // as-is — idempotent, like apply.js re-invoking repair.
    if (host && host.shadowRoot) {
      return { host, root: host.shadowRoot, reused: true };
    }
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      host.setAttribute('data-page-repair', '1');
      (document.body || document.documentElement).appendChild(host);
    }
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BASE_STYLE;
    root.appendChild(style);
    return { host, root, reused: false };
  }

  // Remove the host (and its shadow tree) from the page. Returns whether one
  // was present — the symmetry undo relies on.
  function remove(id) {
    const host = document.getElementById(id);
    if (!host) return false;
    host.remove();
    return true;
  }

  return { createIsolatedHost, remove, BASE_STYLE };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PageRepairIsolate;
}
