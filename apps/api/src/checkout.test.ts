import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from './app.js'
import { AccountStore } from './store/accountStore.js'
import { BondStore } from './store/bondStore.js'
import { BountyStore } from './store/bountyStore.js'
import type { JsonPersist } from './store/persist.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'
import { StripeEventStore } from './store/stripeEventStore.js'
import type { StripeAdapter } from './stripe/client.js'

function memoryPersist(): JsonPersist {
  let data: string | null = null
  return {
    async read() {
      return data
    },
    async write(next) {
      data = next
    },
  }
}

function demoSig(message: string, controllerKey: string): string {
  return createHash('sha256')
    .update(`${message}:${controllerKey}`)
    .digest('hex')
}

const WEBHOOK_SECRET = 'whsec_test_checkout'
const TEST_BSV_USD = 50

describe('Stripe Checkout card funding', () => {
  let app: ReturnType<typeof createApp>
  let bountyStore: BountyStore
  let stripeEvents: StripeEventStore
  const createdSessions: Array<{
    id: string
    url: string
    integrationIdentifier: string
  }> = []
  let sessionSeq = 0

  const adapter: StripeAdapter = {
    async createCheckoutSession(input) {
      sessionSeq += 1
      const id = `cs_test_${sessionSeq}`
      const row = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        integrationIdentifier: input.integrationIdentifier,
      }
      createdSessions.push(row)
      assert.match(input.integrationIdentifier, /^bsvbounties-[a-z]{8}$/)
      assert.equal(input.quote.amountSats > 0, true)
      return { id, url: row.url }
    },
    async constructWebhookEvent(payload, header, secret) {
      const stripeClient = new Stripe('sk_test_placeholder')
      const event = await stripeClient.webhooks.constructEventAsync(
        payload,
        header,
        secret,
      )
      return event as Awaited<ReturnType<StripeAdapter['constructWebhookEvent']>>
    },
  }

  before(async () => {
    process.env.AUTH_MODE = 'both'
    process.env.ESCROW_MODE = 'app'
    process.env.REQUIRE_POSTER_BOND = 'false'
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    process.env.BSV_USD = String(TEST_BSV_USD)
    process.env.USD_FEE_BPS = '290'
    bountyStore = new BountyStore(memoryPersist())
    const accounts = new AccountStore(memoryPersist())
    const sessions = new SessionStore(memoryPersist())
    const challenges = new ChallengeStore(memoryPersist())
    const bonds = new BondStore(memoryPersist())
    stripeEvents = new StripeEventStore(memoryPersist())
    await Promise.all([
      bountyStore.init(),
      accounts.init(),
      sessions.init(),
      challenges.init(),
      bonds.init(),
      stripeEvents.init(),
    ])
    app = createApp({
      publicUrl: 'http://localhost:8787',
      webOrigins: ['http://localhost:5173'],
      network: 'test',
      llm: createLlmFromEnv(),
      stores: {
        bounties: bountyStore,
        accounts,
        sessions,
        challenges,
        bonds,
        stripeEvents,
      },
      stripe: adapter,
    })
  })

  async function json(
    path: string,
    init?: RequestInit & { token?: string },
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const headers = new Headers(init?.headers)
    if (init?.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
    const res = await app.request(path, { ...init, headers })
    const data = (await res.json()) as Record<string, unknown>
    return { status: res.status, data }
  }

  async function mintAndLogin(controllerKey: string): Promise<string> {
    await json('/v1/accounts/mint', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        displayName: 'Card Poster',
        kind: 'agent',
      }),
    })
    const ch = await json('/v1/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ controllerKey }),
    })
    const login = await json('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        controllerKey,
        challenge: ch.data.challenge,
        signature: demoSig(String(ch.data.message), controllerKey),
      }),
    })
    assert.equal(login.status, 200)
    return login.data.token as string
  }

  async function createOpenBounty(token: string): Promise<string> {
    const res = await json('/v1/bounties', {
      method: 'POST',
      token,
      body: JSON.stringify({
        title: 'Card funded task',
        description: 'Need a logo reviewed by an agent',
        category: 'design',
        amountSats: 10_000,
      }),
    })
    assert.equal(res.status, 201)
    const bounty = res.data.bounty as { id: string }
    return bounty.id
  }

  function signedWebhook(body: Record<string, unknown>): {
    payload: string
    header: string
  } {
    const payload = JSON.stringify(body)
    const stripeClient = new Stripe('sk_test_placeholder')
    const header = stripeClient.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    })
    return { payload, header }
  }

  it('GET /v1/funding/config documents USD and sat fees', async () => {
    const res = await json('/v1/funding/config')
    assert.equal(res.status, 200)
    assert.equal(res.data.usdFeeBps, 290)
    assert.equal(res.data.usdFeePercent, '2.90%')
    assert.equal(res.data.satFeeBps, 200)
    assert.equal(res.data.currency, 'usd')
  })

  it('quotes sats as USD cents', async () => {
    const res = await json('/v1/funding/quote?amountSats=100000000')
    assert.equal(res.status, 200)
    assert.equal(res.data.netUsdCents, 5000)
    assert.ok((res.data.totalUsdCents as number) >= 5000)
  })

  it('rejects guest checkout with 401', async () => {
    const token = await mintAndLogin(`guest-check-${Date.now()}`)
    const id = await createOpenBounty(token)
    const res = await json(`/v1/bounties/${id}/checkout`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 401)
    assert.equal(res.data.error, 'unauthorized')
  })

  it('rejects a non-poster session with 403', async () => {
    const poster = await mintAndLogin(`poster-${Date.now()}`)
    const other = await mintAndLogin(`other-${Date.now()}`)
    const id = await createOpenBounty(poster)
    const res = await json(`/v1/bounties/${id}/checkout`, {
      method: 'POST',
      token: other,
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 403)
    assert.equal(res.data.error, 'forbidden')
  })

  it('creates a hosted Checkout Session for the poster', async () => {
    const token = await mintAndLogin(`checkout-${Date.now()}`)
    const id = await createOpenBounty(token)
    const res = await json(`/v1/bounties/${id}/checkout`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    assert.ok(typeof res.data.url === 'string')
    assert.ok(String(res.data.url).startsWith('https://checkout.stripe.com/'))
    assert.match(String(res.data.integrationIdentifier), /^bsvbounties-[a-z]{8}$/)
    const bounty = bountyStore.get(id)
    assert.equal(bounty?.funding?.status, 'pending')
    assert.equal(bounty?.funding?.method, 'card')
    assert.equal(bounty?.funding?.stripeCheckoutSessionId, res.data.sessionId)
  })

  it('webhook without signature is 400', async () => {
    const res = await json('/v1/stripe/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    })
    assert.equal(res.status, 400)
    assert.equal(res.data.error, 'missing_stripe_signature')
  })

  it('webhook with invalid signature is 400', async () => {
    const res = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      body: '{"type":"checkout.session.completed"}',
    })
    const data = (await res.json()) as { error?: string }
    assert.equal(res.status, 400)
    assert.equal(data.error, 'invalid_signature')
  })

  it('checkout.session.completed marks funded and is idempotent on session id', async () => {
    const token = await mintAndLogin(`hook-${Date.now()}`)
    const bountyId = await createOpenBounty(token)
    const checkout = await json(`/v1/bounties/${bountyId}/checkout`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    })
    assert.equal(checkout.status, 200)
    const sessionId = String(checkout.data.sessionId)

    const eventBody = {
      id: 'evt_test_completed',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          payment_status: 'paid',
          amount_total: checkout.data.totalUsdCents,
          client_reference_id: bountyId,
          metadata: { bountyId, amountSats: '10000' },
        },
      },
    }
    const { payload, header } = signedWebhook(eventBody)
    const first = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body: payload,
    })
    const firstData = (await first.json()) as Record<string, unknown>
    assert.equal(first.status, 200)
    assert.equal(firstData.funded, true)
    assert.equal(firstData.sessionId, sessionId)

    const funded = bountyStore.get(bountyId)
    assert.equal(funded?.funding?.status, 'funded')
    assert.equal(funded?.funding?.method, 'card')
    assert.equal(funded?.funding?.stripeCheckoutSessionId, sessionId)
    assert.equal(stripeEvents.has(sessionId), true)

    const second = await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body: payload,
    })
    const secondData = (await second.json()) as Record<string, unknown>
    assert.equal(second.status, 200)
    assert.equal(secondData.duplicate, true)
    assert.equal(bountyStore.get(bountyId)?.funding?.status, 'funded')
  })

  it('already-funded bounty cannot start another checkout', async () => {
    const token = await mintAndLogin(`funded-again-${Date.now()}`)
    const bountyId = await createOpenBounty(token)
    await json(`/v1/bounties/${bountyId}/checkout`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    })
    const sessionId = createdSessions.at(-1)!.id
    const { payload, header } = signedWebhook({
      id: 'evt_test_funded_again',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          payment_status: 'paid',
          metadata: { bountyId },
          client_reference_id: bountyId,
        },
      },
    })
    await app.request('/v1/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body: payload,
    })
    const again = await json(`/v1/bounties/${bountyId}/checkout`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    })
    assert.equal(again.status, 409)
    assert.equal(again.data.error, 'already_funded')
  })
})
