/**
 * Cloudflare Worker: SPA + API under https://entangleit.com/bsvbounties
 */
/// <reference path="../../../worker-configuration.d.ts" />
import type { Network } from '@ai-bounties/shared'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from './app.js'
import { AccountStore } from './store/accountStore.js'
import { BondStore } from './store/bondStore.js'
import { BountyStore } from './store/bountyStore.js'
import { kvPersist } from './store/persist.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'
import { StripeEventStore } from './store/stripeEventStore.js'

const PREFIX = '/bsvbounties'

const ENV_KEYS = [
  'NETWORK',
  'BSV_NETWORK',
  'ESCROW_MODE',
  'AUTH_MODE',
  'PUBLIC_URL',
  'WEB_ORIGIN',
  'REQUIRE_POSTER_BOND',
  'REQUIRE_WORKER_BOND',
  'POSTER_BOND_MIN_SATS',
  'WORKER_BOND_MIN_SATS',
  'REQUIRE_ACCOUNT_FOR_CLAIM',
  'PLATFORM_FEE_BPS',
  'PLATFORM_FEE_PKH',
  'PLATFORM_ADMIN_SECRET',
  'USD_FEE_BPS',
  'BSV_USD',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_BASE_URL',
  'XAI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const

function applyEnv(env: Env) {
  const rec = env as unknown as Record<string, unknown>
  for (const key of ENV_KEYS) {
    const v = rec[key]
    if (typeof v === 'string' && v.length > 0) process.env[key] = v
  }
  process.env.ESCROW_MODE ??= 'app'
  process.env.NETWORK ??= 'test'
}

function isApiPath(pathname: string): boolean {
  const p = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (p === `${PREFIX}/health` || p === `${PREFIX}/openapi.json`) return true
  if (p.startsWith(`${PREFIX}/v1/`)) return true
  if (p.startsWith(`${PREFIX}/.well-known/`)) return true
  return false
}

function toAssetRequest(request: Request): Request {
  const url = new URL(request.url)
  if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
    url.pathname = '/'
  } else if (url.pathname.startsWith(`${PREFIX}/`)) {
    url.pathname = url.pathname.slice(PREFIX.length) || '/'
  }
  return new Request(url.toString(), request)
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  applyEnv(env)
  const kv = env.AI_BOUNTIES
  const stores = {
    bounties: new BountyStore(kvPersist(kv, 'bounties.json')),
    accounts: new AccountStore(kvPersist(kv, 'accounts.json')),
    sessions: new SessionStore(kvPersist(kv, 'sessions.json')),
    challenges: new ChallengeStore(kvPersist(kv, 'challenges.json')),
    bonds: new BondStore(kvPersist(kv, 'bonds.json')),
    stripeEvents: new StripeEventStore(kvPersist(kv, 'stripe-events.json')),
  }
  await Promise.all([
    stores.bounties.init(),
    stores.accounts.init(),
    stores.sessions.init(),
    stores.challenges.init(),
    stores.bonds.init(),
    stores.stripeEvents.init(),
  ])
  const publicUrl = env.PUBLIC_URL || `https://entangleit.com${PREFIX}`
  const app = createApp({
    publicUrl,
    webOrigins: [
      env.WEB_ORIGIN || 'https://entangleit.com',
      'https://entangleit.com',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ],
    network: (env.NETWORK || process.env.NETWORK || 'test') as Network,
    llm: createLlmFromEnv(),
    stores,
    basePath: PREFIX,
  })
  return app.fetch(request)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === PREFIX) {
      url.pathname = `${PREFIX}/`
      return Response.redirect(url.toString(), 301)
    }

    if (!url.pathname.startsWith(PREFIX)) {
      url.pathname = `${PREFIX}${url.pathname === '/' ? '/' : url.pathname}`
      return Response.redirect(url.toString(), 302)
    }

    if (isApiPath(url.pathname)) {
      return handleApi(request, env)
    }

    return env.ASSETS.fetch(toAssetRequest(request))
  },
} satisfies ExportedHandler<Env>
