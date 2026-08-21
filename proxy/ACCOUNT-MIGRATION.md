# Moving the credit proxy to the Beau Access Solutions Cloudflare account

**Status: not done. Do this before the extension is submitted to the Chrome Web
Store, and before `ANTHROPIC_API_KEY` is ever set.**

## Why

This Worker — plus its `TOKENS` KV namespace and its `CreditsAccount` Durable
Object — is deployed on the **langworthywatch** Cloudflare account
(`airboat-webcast.5u@icloud.com`, acct `3b752cee282808bcfcebc84aaea9a1c3`). The
`airboat-webcast-5u.workers.dev` subdomain in the live URL is derived from that
account name. Per the owner's account policy, every asset except langworthywatch
and public-ledger belongs to **Beaudoin0zach** — here that is the Cloudflare
account `Beaudoin0zach@aol.com` (`39d7ced651572ee48cca6a29e1feebe9`), which
already holds the `beauaccesssolutions.com` and `disabilitywiki.org` zones.

## Why the timing is the whole point

Two clocks make this cheap now and expensive later.

**1. The Durable Object holds money, and DO state does not migrate.** A Worker
cannot be transferred between Cloudflare accounts — you redeploy, and the new
account gets a *fresh* `CreditsAccount` namespace. Any per-token balances in the
old one stay behind. Today the proxy is inert (`ANTHROPIC_API_KEY` unset), so
there is nothing to lose. Once real credits are sold, this same move means
migrating live balances and risking double-credit or lost-credit for real users.

**2. The URL is baked into the shipped extension.** The account subdomain
appears in four places, one of which is a reviewed MV3 permission:

| File | Line | What it is |
|---|---|---|
| `manifest.json` | 15 | `host_permissions` entry — **reviewed by the Chrome Web Store** |
| `src/background.js` | 13 | `PROXY_URL` constant the extension actually calls |
| `PRIVACY.md` | 62 | names the hostname user data is sent to |
| `STORE_LISTING.md` | 89 | the permission justification shown to reviewers |

Changing a host permission *after* publishing means a new store review. The
extension has not been submitted yet, so doing this first costs nothing.

## Do this once, so it never happens again: use a custom domain

Do not simply accept the new account's `workers.dev` subdomain — that repeats the
original mistake in a new place, and the extension's permission would be pinned to
another account-derived hostname.

`beauaccesssolutions.com` is already a zone in the **target** account, so bind the
Worker to a stable hostname you own, e.g. `page-repair-proxy.beauaccesssolutions.com`.
Add to `proxy/wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "page-repair-proxy.beauaccesssolutions.com", "custom_domain": true }
]
```

This also reads far better to a store reviewer and in the privacy policy than a
random `*.workers.dev` subdomain.

## Pre-flight

Confirm which account you are on — this is the failure mode that created the
problem, and `wrangler` caches a *selected* account independently of which account
the credential belongs to, so a wrong-credential error looks like a permissions
error:

```bash
npx wrangler whoami
```

If it is not `Beaudoin0zach@aol.com`, re-authenticate (interactive browser flow):

```bash
npx wrangler logout && npx wrangler login
```

Then check whether the old KV namespace holds anything worth copying. Run this
while still authenticated to the **old** account:

```bash
npx wrangler kv key list --namespace-id e0a7eec658d646a194dee95a393d8f78 --remote
```

Expect `[]`. If it lists keys, those are minted access tokens — copy them across
(step 3) rather than reissuing, or you will invalidate whatever holds them.

## Steps

1. **Create the KV namespace in the new account.** KV ids are account-scoped, so
   the existing id cannot be reused.

   ```bash
   npx wrangler kv namespace create TOKENS
   ```

2. **Update `proxy/wrangler.jsonc`** — replace the `TOKENS` `id` with the id the
   previous command printed, and add the `routes` block above. Leave the
   `migrations` block alone: `[{ "tag": "v1", "new_sqlite_classes": ["CreditsAccount"] }]`
   is exactly right for a first deploy into a fresh account.

3. **(Only if step "Pre-flight" found keys)** copy each one:

   ```bash
   npx wrangler kv key put <key> <value> --namespace-id <NEW_ID> --remote
   ```

4. **Deploy to the new account.**

   ```bash
   cd proxy && npx wrangler deploy
   ```

5. **Set the secrets on the new account.** They do not travel with the code.

   ```bash
   npx wrangler secret put ADMIN_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY   # only when going live
   ```

6. **Repoint the extension** — all four references in the table above, to the
   custom domain. `manifest.json` and `src/background.js` are functional; the two
   Markdown files are what a reviewer and a user read.

7. **Verify before deleting anything** (see below).

8. **Delete the old Worker** once the new one is proven, authenticated to the old
   account:

   ```bash
   npx wrangler delete --name page-repair-proxy
   ```

## Verification

The concurrency property is the one that guards money — re-prove it on the new
deployment rather than trusting that it moved. It was originally verified with 50
parallel requests against 1 credit: exactly one got past the spend, 49 returned
`402`, and the balance landed correct.

```bash
# mint a token with 1 credit, then fire 50 concurrent labeling requests
# expect: exactly 1 success, 49x 402, final balance 0
```

Also confirm the new hostname answers, and that the extension reaches it with its
updated host permission (an MV3 permission mismatch fails silently as a blocked
fetch, not an obvious error).

## Rollback

Until step 8, the old Worker is still deployed and functional — reverting means
pointing the four references back and redeploying nothing. After step 8, rollback
means redeploying to the old account, which is why the delete is last and gated on
verification.
