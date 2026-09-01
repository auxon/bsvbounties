# Stripe Checkout (USD card funding)

v1 lets a **logged-in poster** fund a bounty with a card in **USD** without holding BSV.

## Model

- Poster still sets the bounty in **sats** (same create flow as today).
- **Fund with card** opens hosted **Stripe Checkout Sessions**. USD lands on the **platform Stripe account**.
- There is **no on-chain USD→BSV swap**. Solvers are paid in BSV from the **platform BSV float**.
- The sat **payout fee is unchanged** (`PLATFORM_FEE_BPS`, default **2.00%** / 200 bps on approve).
- **No `automatic_tax`.** No Stripe keys in the web client.

## USD fee %

Card charges add a documented USD processing gross-up so the platform Stripe balance can cover Stripe’s US card rate:

| Fee | Default | Env |
|-----|---------|-----|
| USD percentage | **2.90%** | `USD_FEE_BPS=290` |
| USD fixed | **$0.30** | (Stripe US card fixed fee; not configurable) |
| Sat payout fee | **2.00%** | `PLATFORM_FEE_BPS=200` |

Quote: `GET /v1/funding/quote?amountSats=10000` and `GET /v1/funding/config`.

Set `BSV_USD` (USD per 1 BSV) so sats convert to a Checkout `unit_amount` in cents.

## Secrets (never commit, never ship to the client)

Local `.env`:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
BSV_USD=25
USD_FEE_BPS=290
```

Cloudflare Worker `bsv-bounties` (Richard, after merge):

```bash
echo "$STRIPE_SECRET_KEY" | npx wrangler secret put STRIPE_SECRET_KEY
echo "$STRIPE_WEBHOOK_SECRET" | npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

`BSV_USD` and `USD_FEE_BPS` are wrangler **vars** (not secrets) in `wrangler.jsonc`. Update `BSV_USD` when the BSV price moves.

Webhook URL (Dashboard → Developers → Webhooks, event `checkout.session.completed`):

`https://entangleit.com/bsvbounties/v1/stripe/webhook`

Local Stripe CLI:

```bash
stripe listen --forward-to localhost:8787/v1/stripe/webhook
```

## API

Auth is the **same Bearer session as `POST /v1/bounties`** (mint → challenge → login). Guests get **401**.

1. `POST /v1/bounties` — create the listing (sat amount).
2. `POST /v1/bounties/{id}/checkout` — poster-only; returns hosted Checkout `url`. Omits `payment_method_types` (dynamic payment methods). Sets `integration_identifier` to `bsvbounties-` + 8 random letters. Stripe Node **22.x** `StripeClient` (`new Stripe()`), API version **`2026-07-29.dahlia`**.
3. Customer pays on Stripe-hosted Checkout.
4. `POST /v1/stripe/webhook` verifies `Stripe-Signature`, handles `checkout.session.completed`, and marks `funding.status=funded`. **Idempotent on Checkout Session id.**

BSV deposits still use `PATCH /v1/bounties/{id}/escrow` with `escrowTxid` (that path also marks the bounty funded).

## SDK

`apps/api` depends on `stripe` **22.x**. Instantiate a client — do not set a global API key:

```ts
import Stripe from 'stripe'
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-07-29.dahlia',
})
```
