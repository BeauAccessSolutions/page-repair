/*
 * Service worker. Two jobs:
 *   1. Inject + trigger the repair flow when the user invokes it
 *      (toolbar click or keyboard shortcut). Uses activeTab, so the
 *      extension has no access to any page until the user asks.
 *   2. Label ambiguous controls via the Anthropic API. Raw fetch (no SDK —
 *      MV3 service worker, no bundler) with structured output so the reply
 *      is guaranteed-parseable JSON.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';
const PROXY_URL = 'https://page-repair-proxy.airboat-webcast-5u.workers.dev';
const FETCH_TIMEOUT_MS = 60_000;

chrome.action.onClicked.addListener((tab) => sendCommand(tab, 'repair-page'));
chrome.commands.onCommand.addListener((command, tab) => {
  if (['repair-page', 'undo-repairs', 'copy-audit-report'].includes(command)) {
    sendCommand(tab, command);
  }
});

async function sendCommand(tab, type) {
  if (!tab?.id) return;
  try {
    // Ping first so repeat invocations don't stack duplicate listeners.
    let present = false;
    try {
      present = (await chrome.tabs.sendMessage(tab.id, { type: 'ping' })) === 'pong';
    } catch {
      /* not injected yet */
    }
    if (!present) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/audit.js', 'src/apply.js', 'src/content.js'],
      });
    }
    chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    // chrome:// pages, the Web Store, PDFs, etc. — the page can't host the
    // live region, so say so via a system notification (screen readers
    // announce those). Silence here is indistinguishable from being broken.
    console.warn('[page-repair] cannot run here:', e);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Page Repair',
      message: "Page Repair can't run on this page (browser pages, the Web Store, and PDFs are off-limits to extensions).",
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'label-controls') {
    labelControls(msg)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          // The 60s AbortSignal.timeout rejects with a TimeoutError; give it
          // blame-free copy instead of leaking "signal timed out". (This is
          // routed to the assertive live region in content.js.)
          error:
            e && (e.name === 'TimeoutError' || /timed out/i.test(String(e && e.message)))
              ? 'Labeling timed out — check your connection and run repair again.'
              : String((e && e.message) || e),
        })
      );
    return true; // async response
  }
  if (msg.type === 'test-connection') {
    testConnection(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String(e.message || e) }));
    return true;
  }
});

const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          label: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['selector', 'label', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
};

function fetchWithTimeout(url, options) {
  // A hung request must not strand the user listening to silence — the
  // content script is awaiting this to announce success or failure.
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function labelControls({ issues, pageTitle, pageUrl }) {
  const { apiKey, model, proxyToken } = await chrome.storage.local.get([
    'apiKey',
    'model',
    'proxyToken',
  ]);

  // Two modes, personal key wins if both are configured:
  //   1. Bring-your-own-key — calls Anthropic directly, traffic never
  //      touches our servers.
  //   2. Prepaid credits — routes through the page-repair proxy, which
  //      holds the real API key and meters usage.
  if (!apiKey && proxyToken) {
    return labelViaProxy({ issues, pageTitle, pageUrl, proxyToken });
  }
  if (!apiKey) {
    return {
      error:
        'Not configured. Add a personal API key or a credit token in the extension options.',
    };
  }

  // Cap batch size: past ~40 controls the prompt bloats and a partial result
  // beats a slow one. The content script announces the same cap.
  const batch = issues.slice(0, 40);

  const prompt = [
    `You are labeling unnamed interactive controls on a web page so a screen reader user can understand them.`,
    `Page title: ${pageTitle}`,
    `Page URL: ${pageUrl}`,
    ``,
    `For each control below, infer a short action-oriented label (2-5 words, like "Search", "Close dialog", "Next photo") from its HTML context.`,
    `Rate your confidence honestly:`,
    `- "high": the context makes the purpose unambiguous (e.g. class="search-btn" with a magnifier icon)`,
    `- "medium": a reasonable inference that could be wrong`,
    `- "low": you are guessing — these labels will NOT be applied, so never inflate confidence. A wrong label is worse for the user than no label.`,
    ``,
    `Controls:`,
    JSON.stringify(batch, null, 1),
  ].join('\n');

  const t0 = Date.now();
  const res = await fetchWithTimeout(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: LABEL_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    if (res.status === 401) return { error: 'API key rejected. Check it in the extension options.' };
    if (res.status === 429) return { error: 'API rate limit reached. Try again in a minute.' };
    return { error: `Labeling service error (${res.status}).` };
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return { error: 'Model declined the request.' };
  }
  if (data.stop_reason === 'max_tokens') {
    return { error: 'Too many controls for one pass — run repair again.' };
  }
  const text = data.content?.find((b) => b.type === 'text')?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'The model returned an unreadable answer. Try again.' };
  }

  console.log('[page-repair] LLM labeling', {
    controls: batch.length,
    apiMs: Date.now() - t0,
    usage: data.usage,
  });

  return { labels: parsed.labels || [], apiMs: Date.now() - t0 };
}

async function labelViaProxy({ issues, pageTitle, pageUrl, proxyToken }) {
  const t0 = Date.now();
  const res = await fetchWithTimeout(`${PROXY_URL}/v1/label`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${proxyToken}`,
    },
    body: JSON.stringify({ issues: issues.slice(0, 40), pageTitle, pageUrl }),
  });

  if (res.status === 402) {
    return { error: 'Out of labeling credits. Top up to keep labeling controls.' };
  }
  if (res.status === 401 || res.status === 403) {
    return { error: 'Credit token invalid. Check the extension options.' };
  }
  if (!res.ok) {
    return { error: `Labeling service error (${res.status}).` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: 'Labeling service returned an unreadable answer. Try again.' };
  }
  if (typeof data.credits === 'number') {
    // Remembered so the options page can show a balance without spending.
    chrome.storage.local.set({ creditsRemaining: data.credits });
  }
  console.log('[page-repair] proxy labeling', {
    controls: Math.min(issues.length, 40),
    apiMs: Date.now() - t0,
    creditsRemaining: data.credits,
  });
  return { labels: data.labels || [], apiMs: Date.now() - t0, credits: data.credits };
}

// Options-page "Test" buttons: validate credentials without spending
// anything, and return a plain-language sentence — never a raw HTTP body.
async function testConnection({ mode, value }) {
  if (mode === 'apiKey') {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': value,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (res.ok) return { ok: true, message: 'API key works.' };
    if (res.status === 401) return { ok: false, message: 'API key rejected — check for typos.' };
    return { ok: false, message: `Could not verify the key (service returned ${res.status}).` };
  }
  if (mode === 'proxyToken') {
    const res = await fetchWithTimeout(`${PROXY_URL}/v1/balance`, {
      headers: { Authorization: `Bearer ${value}` },
    });
    if (res.ok) {
      const { credits } = await res.json();
      chrome.storage.local.set({ creditsRemaining: credits });
      return { ok: true, message: `Token works. ${credits} credits remaining.`, credits };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'Credit token rejected — check for typos.' };
    }
    return { ok: false, message: `Could not verify the token (service returned ${res.status}).` };
  }
  return { ok: false, message: 'Unknown test mode.' };
}
