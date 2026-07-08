/*
 * Service worker. Two jobs:
 *   1. Inject + trigger the repair flow when the user invokes it
 *      (toolbar click or Alt+Shift+R). Uses activeTab, so the extension has
 *      no access to any page until the user asks.
 *   2. Label ambiguous controls via the Anthropic API. Raw fetch (no SDK —
 *      MV3 service worker, no bundler) with structured output so the reply
 *      is guaranteed-parseable JSON.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_PROXY_URL = 'https://page-repair-proxy.airboat-webcast-5u.workers.dev';

chrome.action.onClicked.addListener((tab) => invokeRepair(tab));
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'repair-page') invokeRepair(tab);
});

async function invokeRepair(tab) {
  if (!tab?.id) return;
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
      files: ['src/audit.js', 'src/apply.js', 'src/ping.js', 'src/content.js'],
    });
  }
  chrome.tabs.sendMessage(tab.id, { type: 'repair-page' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'label-controls') {
    labelControls(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true; // async response
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

async function labelControls({ issues, pageTitle, pageUrl }) {
  const { apiKey, model, proxyUrl, proxyToken } = await chrome.storage.local.get([
    'apiKey',
    'model',
    'proxyUrl',
    'proxyToken',
  ]);

  // Two modes, personal key wins if both are configured:
  //   1. Bring-your-own-key — calls Anthropic directly, traffic never
  //      touches our servers.
  //   2. Prepaid credits — routes through the page-repair proxy, which holds
  //      the real API key and meters usage.
  if (!apiKey && proxyToken) {
    return labelViaProxy({
      issues,
      pageTitle,
      pageUrl,
      proxyUrl: proxyUrl || DEFAULT_PROXY_URL,
      proxyToken,
    });
  }
  if (!apiKey) {
    return {
      error:
        'Not configured. Add a personal API key or a prepaid credit token in the extension options.',
    };
  }

  // Cap batch size: past ~40 controls the prompt bloats and a partial result
  // beats a slow one. Remaining controls simply stay unlabeled this pass.
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
  const res = await fetch(API_URL, {
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
    const body = await res.text();
    return { error: `API error ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return { error: 'Model declined the request.' };
  }
  const text = data.content?.find((b) => b.type === 'text')?.text || '{}';
  const parsed = JSON.parse(text);

  console.log('[page-repair] LLM labeling', {
    controls: batch.length,
    apiMs: Date.now() - t0,
    usage: data.usage,
  });

  return { labels: parsed.labels || [], apiMs: Date.now() - t0 };
}

async function labelViaProxy({ issues, pageTitle, pageUrl, proxyUrl, proxyToken }) {
  const t0 = Date.now();
  const res = await fetch(`${proxyUrl.replace(/\/$/, '')}/v1/label`, {
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

  const data = await res.json();
  console.log('[page-repair] proxy labeling', {
    controls: Math.min(issues.length, 40),
    apiMs: Date.now() - t0,
    creditsRemaining: data.credits,
  });
  return { labels: data.labels || [], apiMs: Date.now() - t0, credits: data.credits };
}
