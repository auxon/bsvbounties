import type { BountyFunding } from '@ai-bounties/shared'
import type { BountyStore } from '../store/bountyStore.js'
import type { StripeEventStore } from '../store/stripeEventStore.js'
import type { CheckoutSessionObject } from './client.js'

export type FulfillResult = {
  received: true
  duplicate?: boolean
  funded?: boolean
  ignored?: string
  bountyId?: string
  sessionId: string
}

export async function fulfillCheckoutSession(opts: {
  bounties: BountyStore
  events: StripeEventStore
  session: CheckoutSessionObject
}): Promise<FulfillResult> {
  const { bounties, events, session } = opts
  const sessionId = session.id

  if (events.has(sessionId)) {
    return {
      received: true,
      duplicate: true,
      sessionId,
      bountyId: events.get(sessionId)?.bountyId,
    }
  }

  if (session.payment_status && session.payment_status !== 'paid') {
    return {
      received: true,
      ignored: 'payment_not_paid',
      sessionId,
    }
  }

  const bountyId =
    session.metadata?.bountyId || session.client_reference_id || ''
  if (!bountyId) {
    return { received: true, ignored: 'missing_bounty_id', sessionId }
  }

  const bounty = bounties.get(bountyId)
  if (!bounty) {
    await events.mark(sessionId, bountyId)
    return { received: true, ignored: 'bounty_not_found', sessionId, bountyId }
  }

  if (
    bounty.funding?.status === 'funded' &&
    bounty.funding.stripeCheckoutSessionId === sessionId
  ) {
    await events.mark(sessionId, bountyId)
    return { received: true, duplicate: true, sessionId, bountyId }
  }

  if (bounty.funding?.status === 'funded') {
    await events.mark(sessionId, bountyId)
    return { received: true, duplicate: true, funded: true, sessionId, bountyId }
  }

  const funding: BountyFunding = {
    ...bounty.funding,
    method: 'card',
    status: 'funded',
    stripeCheckoutSessionId: sessionId,
    amountUsdCents: session.amount_total ?? bounty.funding?.amountUsdCents,
    fundedAt: new Date().toISOString(),
  }

  await bounties.update(bountyId, { funding })
  await events.mark(sessionId, bountyId)
  return { received: true, funded: true, sessionId, bountyId }
}
