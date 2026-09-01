import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Network } from '@ai-bounties/shared'
import {
  escrowMode,
  isScryptArtifactAvailable,
  networkName,
} from '@ai-bounties/contracts'
import type { LlmClient } from '@ai-bounties/llm'
import type { BountyStore } from './store/bountyStore.js'
import type { AccountStore } from './store/accountStore.js'
import type { BondStore } from './store/bondStore.js'
import type { ChallengeStore, SessionStore } from './store/sessionStore.js'
import { bountyRoutes } from './routes/bounties.js'
import { accountRoutes } from './routes/accounts.js'
import { authRoutes } from './routes/auth.js'
import { bondRoutes } from './routes/bonds.js'
import { llmRoutes } from './routes/llm.js'
import { fundingRoutes, stripeWebhookRoutes } from './routes/stripe.js'
import { buildAgentCard, buildOpenApi } from './openapi.js'
import { StripeEventStore } from './store/stripeEventStore.js'
import { stripeAdapterFromEnv, type StripeAdapter } from './stripe/client.js'
import { satFeeBpsFromEnv, usdFeeBpsFromEnv } from './stripe/quote.js'

export type AppStores = {
  bounties: BountyStore
  accounts: AccountStore
  sessions: SessionStore
  challenges: ChallengeStore
  bonds: BondStore
  stripeEvents?: StripeEventStore
}

export type CreateAppConfig = {
  publicUrl: string
  webOrigins: string[]
  network: Network
  llm: LlmClient
  stores: AppStores
  /** Mount API under a prefix (e.g. `/bsvbounties` on Cloudflare). */
  basePath?: string
  /** Injected in tests; default is env STRIPE_SECRET_KEY. Pass `null` to force off. */
  stripe?: StripeAdapter | null
}

function scryptArtifactSafe(): boolean {
  try {
    return isScryptArtifactAvailable()
  } catch {
    return false
  }
}

function checkoutReturnBase(config: CreateAppConfig): string {
  const pub = config.publicUrl.replace(/\/$/, '')
  if (pub.includes('/bsvbounties')) return pub
  const web = config.webOrigins.find(Boolean)
  return (web || pub).replace(/\/$/, '')
}

export function createApp(config: CreateAppConfig): Hono {
  const inner = new Hono()
  const { bounties, accounts, sessions, challenges, bonds } = config.stores
  const stripeEvents =
    config.stores.stripeEvents ?? new StripeEventStore()
  const stripeAdapter =
    config.stripe === undefined ? stripeAdapterFromEnv() : config.stripe
  const origins = [...new Set(config.webOrigins.filter(Boolean))]

  inner.use('*', logger())
  inner.use(
    '*',
    cors({
      origin: origins,
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret'],
    }),
  )

  inner.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'ai-bounties-api',
      version: '0.6.0',
      phase: 6,
      network: config.network,
      bsvNetwork: networkName(),
      escrowMode: escrowMode(),
      scryptArtifact: scryptArtifactSafe(),
      bounties: bounties.count(),
      open: bounties.count('open'),
      accounts: accounts.count(),
      forSale: accounts.listForSaleCount(),
      activeBonds: bonds.countActive(),
      requirePosterBond: process.env.REQUIRE_POSTER_BOND === 'true',
      requireWorkerBond: process.env.REQUIRE_WORKER_BOND === 'true',
      authMode: process.env.AUTH_MODE ?? 'both',
      stripeConfigured: Boolean(stripeAdapter),
      usdFeeBps: usdFeeBpsFromEnv(),
      satFeeBps: satFeeBpsFromEnv(),
      mcp: `${config.publicUrl.replace(/\/$/, '')} → run apps/mcp (stdio)`,
    }),
  )

  inner.get('/v1/chain', async (c) => {
    let wallet: unknown = { note: 'on-chain wallet probe skipped' }
    try {
      const { fundInfo } = await import('@ai-bounties/contracts')
      wallet = await fundInfo()
    } catch (e) {
      wallet = { error: e instanceof Error ? e.message : String(e) }
    }
    return c.json({
      network: networkName(),
      escrowMode: escrowMode(),
      scryptArtifact: scryptArtifactSafe(),
      wallet,
      faucets: [
        'https://bsvfaucet.com/',
        'https://scrypt.io/faucet',
        'https://witnessonchain.com/faucet/tbsv',
        'https://testnet.help/en/bsvfaucet/testnet',
      ],
      explorer:
        networkName() === 'test'
          ? 'https://test.whatsonchain.com'
          : 'https://whatsonchain.com',
    })
  })

  inner.get('/openapi.json', (c) => c.json(buildOpenApi(config.publicUrl)))
  inner.get('/.well-known/agent.json', (c) =>
    c.json(buildAgentCard(config.publicUrl)),
  )
  inner.get('/.well-known/ai-plugin.json', (c) =>
    c.json({
      schema_version: 'v1',
      name_for_human: 'AI Bounties',
      name_for_model: 'ai_bounties',
      description_for_human:
        'BSV bounties, tradable accounts, escrow, poster bonds. MCP server available for agents.',
      description_for_model:
        'Mint accounts, deposit poster bonds, post/claim BSV bounties with escrow, atomic account swaps. Prefer OpenAPI or MCP tools. POST /v1/bounties requires Bearer session from auth login.',
      auth: {
        type: 'bearer',
        authorization_url: `${config.publicUrl}/v1/auth/login`,
      },
      api: {
        type: 'openapi',
        url: `${config.publicUrl}/openapi.json`,
      },
      logo_url: `${config.publicUrl}/health`,
      contact_email: 'dev@localhost',
    }),
  )

  inner.route(
    '/v1/bounties',
    bountyRoutes(
      bounties,
      config.network,
      accounts,
      sessions,
      bonds,
      config.llm,
      {
        adapter: stripeAdapter,
        events: stripeEvents,
        returnBase: checkoutReturnBase(config),
      },
    ),
  )
  inner.route('/v1/accounts', accountRoutes(accounts, sessions, config.network))
  inner.route('/v1/auth', authRoutes(accounts, sessions, challenges))
  inner.route('/v1/bonds', bondRoutes(bonds, sessions, config.network))
  inner.route('/v1/llm', llmRoutes(bounties, accounts, config.llm))
  inner.route('/v1/funding', fundingRoutes())
  inner.route(
    '/v1/stripe',
    stripeWebhookRoutes(bounties, stripeEvents, stripeAdapter),
  )

  inner.onError((err, c) => {
    console.error(err)
    if (err.name === 'ZodError') {
      return c.json({ error: 'validation_error', details: err }, 400)
    }
    return c.json({ error: 'internal_error', message: err.message }, 500)
  })

  if (!config.basePath) return inner

  const root = new Hono()
  root.route(config.basePath, inner)
  return root
}
