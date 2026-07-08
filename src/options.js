const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('model');
const proxyTokenInput = document.getElementById('proxyToken');
const proxyUrlInput = document.getElementById('proxyUrl');
const status = document.getElementById('status');
const bundlePrices = document.getElementById('bundlePrices');

// Keep in sync with DEFAULT_PROXY_URL in background.js.
const DEFAULT_PROXY_URL = 'https://page-repair-proxy.airboat-webcast-5u.workers.dev';

// Pull prices from the proxy so the options page never hard-codes an amount
// that could drift from the bundles the service actually charges.
async function loadBundles(proxyUrl) {
  const base = (proxyUrl || DEFAULT_PROXY_URL).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v1/bundles`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { bundles } = await res.json();
    if (!Array.isArray(bundles) || bundles.length === 0) return;
    const priced = bundles
      .map((b) => `${b.credits} credits for $${(b.amountCents / 100).toFixed(2).replace(/\.00$/, '')}`)
      .join(' · ');
    bundlePrices.textContent = `Bundles: ${priced}.`;
  } catch {
    // Offline or self-hosted proxy without this route — just show nothing.
    bundlePrices.textContent = '';
  }
}

chrome.storage.local
  .get(['apiKey', 'model', 'proxyToken', 'proxyUrl'])
  .then(({ apiKey, model, proxyToken, proxyUrl }) => {
    if (apiKey) apiKeyInput.value = apiKey;
    if (model) modelSelect.value = model;
    if (proxyToken) proxyTokenInput.value = proxyToken;
    if (proxyUrl) proxyUrlInput.value = proxyUrl;
    loadBundles(proxyUrl);
  });

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    proxyToken: proxyTokenInput.value.trim(),
    proxyUrl: proxyUrlInput.value.trim(),
  });
  status.textContent = 'Saved.';
  setTimeout(() => (status.textContent = ''), 3000);
  loadBundles(proxyUrlInput.value.trim());
});
