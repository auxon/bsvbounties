import { Hono } from 'hono'
import type { BountyStore } from '../store/bountyStore.js'
import type { StripeEventStore } from '../store/stripeEventStore.js'
import {
  asCheckoutSession,
  type StripeAdapter,
} from '../stripe/client.js'
import { fulfillCheckoutSession } from '../stripe/fulfill.js'
import {
  bsvUsdFromEnv,
  quoteCardCharge,
  satFeeBpsFromEnv,
  usdFeeBpsFromEnv,
  usdFeePercent,
} from '../stripe/quote.js'

export function fundingRoutes() {
  const app = new Hono()

  app.get('/config', (c) => {
    const usdFeeBps = usdFeeBpsFromEnv()
    const satFeeBps = satFeeBpsFromEnv()
    const bsvUsd = bsvUsdFromEnv()
    return c.json({
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
      bsvUsd,
      usdFeeBps,
      usdFeePercent: usdFeePercent(usdFeeBps),
      satFeeBps,
      satFeePercent: usdFeePercent(satFeeBps),
      stripeFixedFeeCents: 30,
      currency: 'usd',
      note:
        'v1: USD is collected on the platform Stripe account (no on-chain USD→BSV). ' +
        `Card charge adds ${usdFeePercent(usdFeeBps)} + $0.30. ` +
        `Solver payout still takes the sat fee (${usdFeePercent(satFeeBps)} / PLATFORM_FEE_BPS).`,
    })
  })

  app.get('/quote', (c) => {
    const amountSats = Number(c.req.query('amountSats'))
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      return c.json({ error: 'invalid_amount_sats' }, 400)
    }
    const bsvUsd = bsvUsdFromEnv()
    if (bsvUsd == null) {
      return c.json(
        {
          error: 'bsv_usd_rate_missing',
          note: 'Set BSV_USD (USD per BSV) as a wrangler var or .env value to quote card charges.',
        },
        503,
      )
    }
    const quote = quoteCardCharge({ amountSats, bsvUsd })
    return c.json({
      ...quote,
      usdFeePercent: usdFeePercent(quote.usdFeeBps),
      satFeeBps: satFeeBpsFromEnv(),
      satFeePercent: usdFeePercent(satFeeBpsFromEnv()),
    })
  })

  return app
}

export function stripeWebhookRoutes(
  bounties: BountyStore,
  events: StripeEventStore,
  stripe: StripeAdapter | null,
) {
  const app = new Hono()

  app.post('/webhook', async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret || !stripe) {
      return c.json(
        {
          error: 'stripe_webhook_not_configured',
          note: 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (wrangler secrets).',
        },
        503,
      )
    }
    const signature = c.req.header('stripe-signature')
    if (!signature) {
      return c.json({ error: 'missing_stripe_signature' }, 400)
    }
    const payload = await c.req.text()
    let event
    try {
      event = await stripe.constructWebhookEvent(payload, signature, secret)
    } catch {
      return c.json({ error: 'invalid_signature' }, 400)
    }

    if (event.type !== 'checkout.session.completed') {
      return c.json({ received: true, ignored: event.type })
    }

    const session = asCheckoutSession(event.data.object)
    if (!session) {
      return c.json({ received: true, ignored: 'invalid_session' })
    }

    const result = await fulfillCheckoutSession({ bounties, events, session })
    return c.json(result)
  })

  return app
}
