// Secrets set with `wrangler secret put <NAME>` live outside wrangler.jsonc,
// so `wrangler types` never generates them into the Env interface. Declare
// them here (declaration-merged into the generated global `Env`) so the
// Worker typechecks against them.
//
//   ANTHROPIC_API_KEY     — server-held key all paid traffic uses
//   ADMIN_SECRET          — authorizes /admin/* routes
//   STRIPE_WEBHOOK_SECRET — verifies Stripe event signatures (empty until wired)
interface Env {
  ANTHROPIC_API_KEY: string;
  ADMIN_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
}
