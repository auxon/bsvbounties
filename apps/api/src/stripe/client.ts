import Stripe from 'stripe'
import type { Bounty } from '@ai-bounties/shared'
import type { CardQuote } from './quote.js'

/**
 * Stripe API version requested for this integration.
 * stripe-node 22.6 types pin LatestApiVersion to 2026-08-26.dahlia; we still
 * send 2026-07-29.dahlia on the wire.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia'

export type CheckoutCreateInput = {
  bounty: Bounty
  quote: CardQuote
  successUrl: string
  cancelUrl: string
  integrationIdentifier: string
}

export type CheckoutCreateResult = {
  id: string
  url: string
}

/** Minimal Checkout Session fields the webhook fulfills on. */
export type CheckoutSessionObject = {
  id: string
  object?: string
  payment_status?: string | null
  metadata?: Record<string, string> | null
  client_reference_id?: string | null
  amount_total?: number | null
}

export type StripeWebhookEvent = {
  id: string
  type: string
  data: { object: CheckoutSessionObject | Record<string, unknown> }
}

export interface StripeAdapter {
  createCheckoutSession(input: CheckoutCreateInput): Promise<CheckoutCreateResult>
  constructWebhookEvent(
    payload: string,
    header: string,
    secret: string,
  ): Promise<StripeWebhookEvent>
}

/** 8 random lowercase letters for Stripe `integration_identifier` suffix. */
export function randomLetterSuffix(length = 8): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => letters[b % 26]!).join('')
}

export function checkoutIntegrationIdentifier(): string {
  return `bsvbounties-${randomLetterSuffix(8)}`
}

/**
 * StripeClient for stripe-node 22.x (`new Stripe()` — the class is the client).
 * Do not put this key in the web app.
 */
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    typescript: true,
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  })
}

export function createStripeAdapter(secretKey: string): StripeAdapter {
  const stripeClient = createStripeClient(secretKey)
  return {
    async createCheckoutSession(input) {
      const session = await stripeClient.checkout.sessions.create({
        mode: 'payment',
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.bounty.id,
        integration_identifier: input.integrationIdentifier,
        metadata: {
          bountyId: input.bounty.id,
          amountSats: String(input.bounty.amountSats),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: input.quote.totalUsdCents,
              product_data: {
                name: `BSVBounties · ${input.bounty.title}`.slice(0, 250),
                description:
                  `${input.bounty.amountSats} sats. USD is collected on the platform Stripe account; solvers are paid in BSV from the platform float.`.slice(
                    0,
                    500,
                  ),
              },
            },
          },
        ],
      })
      if (!session.url) {
        throw new Error('stripe_checkout_url_missing')
      }
      return { id: session.id, url: session.url }
    },
    async constructWebhookEvent(payload, header, secret) {
      const event = await stripeClient.webhooks.constructEventAsync(
        payload,
        header,
        secret,
      )
      return event as StripeWebhookEvent
    },
  }
}

export function stripeAdapterFromEnv(): StripeAdapter | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return createStripeAdapter(key)
}

export function asCheckoutSession(
  obj: unknown,
): CheckoutSessionObject | null {
  if (!obj || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id.length < 2) return null
  const metadata =
    rec.metadata && typeof rec.metadata === 'object'
      ? (rec.metadata as Record<string, string>)
      : null
  return {
    id: rec.id,
    object: typeof rec.object === 'string' ? rec.object : undefined,
    payment_status:
      typeof rec.payment_status === 'string' ? rec.payment_status : null,
    metadata,
    client_reference_id:
      typeof rec.client_reference_id === 'string'
        ? rec.client_reference_id
        : null,
    amount_total:
      typeof rec.amount_total === 'number' ? rec.amount_total : null,
  }
}
