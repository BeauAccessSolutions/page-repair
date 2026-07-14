/*
 * Page Repair proxy — the "pay to use" backend.
 *
 * Purpose-built labeling service, NOT a general Claude passthrough: the
 * prompt is constructed server-side from the extension's issue list, so a
 * leaked subscriber token can only spend quota on control labeling.
 *
 * Billing model: prepaid credits. 1 credit = 1 labeling request (a "page
 * repair", capped at 40 controls). No subscription, no renewal — customers
 * top up when they run out.
 *
 * Endpoints:
 *   POST /v1/label        — label unnamed controls (Bearer customer token);
 *                           spends 1 credit
 *   GET  /v1/balance      — remaining credits (Bearer customer token); free
 *   POST /admin/tokens    — mint a customer token with a starting balance
 *                           (Bearer ADMIN_SECRET)
 *   POST /admin/credits   — top up an existing token (Bearer ADMIN_SECRET)
 *
 * Storage:
 *   KV  token:<sha256(token)>  -> TokenRecord JSON (metadata + disabled flag)
 *   DO  CreditsAccount[hash]   -> the credit balance, one Durable Object per
 *                                 token. Balance mutation lives here so the
 *                                 spend is atomic: a DO serializes concurrent
 *                                 requests, so "read balance, decrement if >0"
 *                                 cannot interleave the way a KV read-then-put
 *                                 can. This is the hard prepaid-limit enforcer
 *                                 that a leaked token cannot race past.
 */

import { DurableObject } from 'cloudflare:workers';

interface TokenRecord {
  createdAt: string;
  plan: 'credits';
  disabled?: boolean;
  note?: string;
}

interface LabelIssue {
  selector: string;
  context: Record<string, unknown>;
}

interface LabelRequestBody {
  issues: LabelIssue[];
  pageTitle?: string;
  pageUrl?: string;
}

const MAX_CONTROLS_PER_REQUEST = 40;
const MAX_BODY_BYTES = 256 * 1024;

// The context object is untrusted client input that goes straight into the
// prompt. Whitelist its fields and cap each one to the same budgets the
// extension's audit uses, so a hostile client can't inflate token spend.
const CONTEXT_FIELD_CAPS: Record<string, number> = {
  tag: 20,
  classes: 120,
  href: 300,
  type: 30,
  name: 100,
  placeholder: 200,
  innerHtml: 300,
  nearbyText: 200,
};

function sanitizeContext(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const src = raw as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [field, cap] of Object.entries(CONTEXT_FIELD_CAPS)) {
    if (typeof src[field] === 'string') clean[field] = (src[field] as string).slice(0, cap);
  }
  if (typeof src.dataAttrs === 'object' && src.dataAttrs !== null) {
    const dataAttrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.dataAttrs as Record<string, unknown>).slice(0, 5)) {
      dataAttrs[k.slice(0, 60)] = String(v).slice(0, 60);
    }
    clean.dataAttrs = dataAttrs;
  }
  return clean;
}

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
} as const;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compare via digests so lengths always match and comparison is constant-time.
async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/);
  return match ? match[1].trim() : null;
}

/**
 * One Durable Object per token holds that token's credit balance. Because a
 * DO processes calls to a given instance one at a time, the read-modify-write
 * inside spend() is atomic — N concurrent /v1/label requests on the same
 * token are serialized, so exactly `balance` of them can spend, not all N.
 * This is what turns "fire 200 in parallel on 1 credit" from a lottery into
 * a hard limit.
 */
export class CreditsAccount extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS account (
           id INTEGER PRIMARY KEY CHECK (id = 0),
           balance INTEGER NOT NULL DEFAULT 0
         )`
      );
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO account (id, balance) VALUES (0, 0)');
    });
  }

  balance(): number {
    return this.ctx.storage.sql
      .exec<{ balance: number }>('SELECT balance FROM account WHERE id = 0')
      .one().balance;
  }

  /**
   * Atomically decrement if the balance is positive. Returns whether a credit
   * was spent and the resulting balance. The conditional UPDATE ... RETURNING
   * yields zero rows when the balance was already 0, so no over-spend slips
   * through even under concurrency (calls to one DO instance are serialized).
   */
  spend(): { ok: boolean; balance: number } {
    const rows = this.ctx.storage.sql
      .exec<{ balance: number }>(
        'UPDATE account SET balance = balance - 1 WHERE id = 0 AND balance > 0 RETURNING balance'
      )
      .toArray();
    if (rows.length === 0) return { ok: false, balance: this.balance() };
    return { ok: true, balance: rows[0].balance };
  }

  /** Return a spent credit after an upstream failure. */
  refund(): number {
    return this.ctx.storage.sql
      .exec<{ balance: number }>(
        'UPDATE account SET balance = balance + 1 WHERE id = 0 RETURNING balance'
      )
      .one().balance;
  }

  /** Set the balance to an exact value (used when minting a token). */
  grant(credits: number): void {
    this.ctx.storage.sql.exec('UPDATE account SET balance = ? WHERE id = 0', Math.max(0, credits));
  }

  /** Add credits (top-up) and return the new balance. */
  topup(add: number): number {
    return this.ctx.storage.sql
      .exec<{ balance: number }>(
        'UPDATE account SET balance = balance + ? WHERE id = 0 RETURNING balance',
        add
      )
      .one().balance;
  }
}

function creditsAccount(env: Env, tokenHash: string): DurableObjectStub<CreditsAccount> {
  return env.CREDITS.getByName(tokenHash);
}

function buildPrompt(issues: LabelIssue[], pageTitle: string, pageUrl: string): string {
  return [
    'You are labeling unnamed interactive controls on a web page so a screen reader user can understand them.',
    `Page title: ${pageTitle}`,
    `Page URL: ${pageUrl}`,
    '',
    'For each control below, infer a short action-oriented label (2-5 words, like "Search", "Close dialog", "Next photo") from its HTML context.',
    'Rate your confidence honestly:',
    '- "high": the context makes the purpose unambiguous',
    '- "medium": a reasonable inference that could be wrong',
    '- "low": you are guessing — these labels will NOT be applied, so never inflate confidence. A wrong label is worse for the user than no label.',
    '',
    'Controls:',
    JSON.stringify(issues, null, 1),
  ].join('\n');
}

async function handleLabel(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: 'Missing bearer token' }, 401);

  const tokenHash = await sha256Hex(token);
  const record = await env.TOKENS.get<TokenRecord>(`token:${tokenHash}`, 'json');
  if (!record || record.disabled) return json({ error: 'Invalid or disabled token' }, 403);

  // Cap on the actual bytes, not the Content-Length header — chunked
  // requests carry no Content-Length and would bypass a header-only check.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);

  let body: LabelRequestBody;
  try {
    body = JSON.parse(rawBody) as LabelRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.issues) || body.issues.length === 0) {
    return json({ error: 'issues[] required' }, 400);
  }

  // Spend the credit up front and refund on upstream failure. The per-token
  // Durable Object serializes concurrent spends, so this is a hard prepaid
  // limit — not a narrowed race window. A spend that finds no balance returns
  // ok:false and we stop before reaching Anthropic.
  const account = creditsAccount(env, tokenHash);
  const spent = await account.spend();
  if (!spent.ok) {
    return json({ error: 'Out of credits', credits: 0 }, 402);
  }
  const remaining = spent.balance;
  const refund = () => account.refund().then(() => undefined).catch(() => {});

  const issues = body.issues.slice(0, MAX_CONTROLS_PER_REQUEST).map((i) => ({
    selector: String(i.selector).slice(0, 500),
    context: sanitizeContext(i.context),
  }));
  const prompt = buildPrompt(
    issues,
    String(body.pageTitle || '').slice(0, 300),
    String(body.pageUrl || '').slice(0, 500)
  );

  let apiRes: Response;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.MODEL,
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: LABEL_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    ctx.waitUntil(refund());
    console.log(JSON.stringify({ event: 'anthropic_unreachable', message: String(e) }));
    return json({ error: 'Labeling service temporarily unavailable' }, 502);
  }

  if (!apiRes.ok) {
    ctx.waitUntil(refund());
    const detail = (await apiRes.text()).slice(0, 300);
    console.log(JSON.stringify({ event: 'anthropic_error', status: apiRes.status, detail }));
    // Don't leak upstream details to the client beyond the status class.
    return json({ error: 'Labeling service temporarily unavailable' }, 502);
  }

  interface AnthropicResponse {
    stop_reason: string;
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  }
  const data = await apiRes.json<AnthropicResponse>();
  if (data.stop_reason === 'refusal') {
    ctx.waitUntil(refund());
    return json({ error: 'Model declined the request' }, 502);
  }

  const text = data.content.find((b) => b.type === 'text')?.text ?? '{}';
  let labels: unknown = [];
  try {
    labels = (JSON.parse(text) as { labels?: unknown }).labels ?? [];
  } catch {
    ctx.waitUntil(refund());
    return json({ error: 'Malformed model output' }, 502);
  }

  console.log(
    JSON.stringify({
      event: 'label',
      controls: issues.length,
      apiTokens: data.usage.input_tokens + data.usage.output_tokens,
      creditsRemaining: remaining,
    })
  );

  return json({ labels, credits: remaining });
}

// Free balance check so the extension's options page can show credits (and
// validate a token) without spending one.
async function handleBalance(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: 'Missing bearer token' }, 401);
  const tokenHash = await sha256Hex(token);
  const record = await env.TOKENS.get<TokenRecord>(`token:${tokenHash}`, 'json');
  if (!record || record.disabled) return json({ error: 'Invalid or disabled token' }, 403);
  return json({ credits: await creditsAccount(env, tokenHash).balance() });
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const provided = bearerToken(request);
  if (!provided || !(await timingSafeEqualStrings(provided, env.ADMIN_SECRET))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

async function handleCreateToken(request: Request, env: Env): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const note = params.get('note') || undefined;
  const credits = Math.max(0, Number(params.get('credits') ?? env.DEFAULT_STARTING_CREDITS));

  const token = `prt_${crypto.randomUUID().replace(/-/g, '')}`;
  const tokenHash = await sha256Hex(token);
  const record: TokenRecord = { createdAt: new Date().toISOString(), plan: 'credits', note };
  await Promise.all([
    env.TOKENS.put(`token:${tokenHash}`, JSON.stringify(record)),
    creditsAccount(env, tokenHash).grant(credits),
  ]);
  // The plaintext token is returned exactly once and never stored.
  return json({ token, credits, record }, 201);
}

// Top up an existing token: body {"token": "prt_...", "add": 100}.
// The customer supplies their token when purchasing, so the Stripe webhook
// (and manual admin top-ups) can credit the balance without a user account.
async function handleAddCredits(request: Request, env: Env): Promise<Response> {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  let body: { token?: string; add?: number };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const add = Number(body.add);
  if (!body.token || !Number.isFinite(add) || add <= 0) {
    return json({ error: 'token and positive add required' }, 400);
  }

  const tokenHash = await sha256Hex(body.token);
  const record = await env.TOKENS.get<TokenRecord>(`token:${tokenHash}`, 'json');
  if (!record) return json({ error: 'Unknown token' }, 404);

  const credits = await creditsAccount(env, tokenHash).topup(add);
  console.log(JSON.stringify({ event: 'topup', add, credits }));
  return json({ credits });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Friendly health/info root so uptime checks and curious visitors get a
      // 200 instead of a bare 404. Reveals nothing sensitive.
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        return json({ service: 'page-repair-proxy', status: 'ok' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/label') {
        return await handleLabel(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/v1/balance') {
        return await handleBalance(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/admin/tokens') {
        return await handleCreateToken(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/admin/credits') {
        return await handleAddCredits(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.log(JSON.stringify({ event: 'unhandled_error', message: String(e) }));
      return json({ error: 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
