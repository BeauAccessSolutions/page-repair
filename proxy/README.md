# Page Repair proxy

Cloudflare Worker backing the extension's prepaid-credits ("pay to use")
mode. Holds the real Anthropic API key server-side, authenticates customers
by token, spends 1 credit per labeling request, and builds the labeling
prompt itself — so a leaked token can only spend its own credits on control
labeling, never arbitrary API calls.

**Billing model: prepaid credits, no subscription.** 1 credit = 1 page
repair (up to 40 controls). Customers top up when they run out; nothing
renews on its own. Bring-your-own-key mode stays free — credits only apply
to the hosted proxy.

**Bundles** (defined once in `BUNDLES` in `src/index.ts`, served at
`GET /v1/bundles`):

| Bundle | Price | Credits | Per credit | Stripe fee | Fixed-fee share |
|---|---|---|---|---|---|
| Starter | $6 | 240 | $0.025 | $0.47 | 5% |
| Plus | $10 | 500 | $0.02 | $0.59 | 3% |

Stripe charges 2.9% + $0.30 per transaction, so on tiny bundles the fixed
$0.30 dominates: the old "$3 for 100 credits" lost ~10% to that flat fee
alone. Sizing the smallest bundle at $6 puts the fixed-fee share right at 5%
(and 3% at $10) without raising the per-credit price. At ~$0.005–0.01/page
on Haiku, $0.02–0.025/credit stays honest for the price-sensitive AT
community — the goal here is fee efficiency, not margin.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/label` | `Bearer <customer token>` | Label unnamed controls; spends 1 credit; 402 when balance is 0 |
| `GET /v1/bundles` | — | Public catalog of purchasable credit bundles (price + credits) |
| `GET /v1/checkout?session_id=...` | — | One-time hand-off of a token minted at checkout, for the Stripe success page |
| `POST /admin/tokens?credits=N&note=...` | `Bearer <ADMIN_SECRET>` | Mint a customer token with a starting balance (token returned once, stored hashed) |
| `POST /admin/credits` `{token, add}` | `Bearer <ADMIN_SECRET>` | Top up an existing token |
| `POST /webhooks/stripe` | Stripe signature | One-time payments: mint a token or top up (via checkout metadata). 501 until `STRIPE_WEBHOOK_SECRET` is set |

## Deploy

```sh
cd proxy
npm install
npx wrangler kv namespace create TOKENS   # paste the id into wrangler.jsonc
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

Mint a customer token (default starting balance comes from
`DEFAULT_STARTING_CREDITS`; override with `?credits=N`):

```sh
curl -X POST "https://page-repair-proxy.<subdomain>.workers.dev/admin/tokens?credits=100&note=zach" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Top up later:

```sh
curl -X POST "https://page-repair-proxy.<subdomain>.workers.dev/admin/credits" \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"token": "prt_...", "add": 100}'
```

Give the `prt_...` token + the worker URL to the extension's options page
(Option B).

## Local dev

`.dev.vars` (gitignored) provides placeholder secrets. `npm run dev`, then:

```sh
curl -X POST "http://localhost:8787/admin/tokens" -H "Authorization: Bearer local-dev-admin-secret"
```

`npm run check` regenerates `Env` types and typechecks.

## Design notes

- Tokens are stored as SHA-256 hashes; the plaintext exists only in the
  201 response. Admin auth is compared timing-safely.
- Balances live in KV (`credits:<hash>`). KV is eventually consistent, so a
  racing pair of requests can occasionally spend one credit twice — errs in
  the customer's favor; move to D1 if hard enforcement ever matters.
- Model is `claude-haiku-4-5` by default (the ~$0.01/page economics the
  pricing is built on); set `MODEL=claude-opus-4-8` for maximum label
  quality.
- Stripe flow (one-time payments only, no subscription lifecycle): the
  webhook verifies the `Stripe-Signature` header with `STRIPE_WEBHOOK_SECRET`
  (HMAC-SHA256, 5-minute replay window, no SDK) and on
  `checkout.session.completed` derives the credit grant from the amount paid
  via `creditsForAmountCents(session.amount_total)` so it always matches a
  `BUNDLES` entry. No token in metadata → mint a token, stash it under
  `checkout:<session id>` (1h TTL); the success page reads it once via
  `GET /v1/checkout?session_id={CHECKOUT_SESSION_ID}`. Token in metadata →
  top up that balance. Duplicate deliveries are de-duped by event id (24h
  TTL, best-effort since KV is eventually consistent).
- Keep the Stripe Product/Price amounts in sync with `BUNDLES` (600¢ / 1000¢)
  — an amount that matches no bundle is acked and ignored (logged as
  `stripe_unknown_amount`), never converted to credits.

## Enable Stripe

1. Create two Prices (one-time): **$6.00** and **$10.00**, matching `BUNDLES`.
2. Set the success URL to your page with `?session_id={CHECKOUT_SESSION_ID}`;
   for top-ups, pass the customer's token as checkout `metadata[token]`.
3. Add the webhook endpoint `POST /webhooks/stripe` for
   `checkout.session.completed`, then `wrangler secret put STRIPE_WEBHOOK_SECRET`
   with its signing secret. Until that secret exists the route returns 501.
