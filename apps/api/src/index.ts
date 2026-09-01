import { config as loadEnv } from 'dotenv'
import { serve } from '@hono/node-server'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Network } from '@ai-bounties/shared'
import { escrowMode, isScryptArtifactAvailable, networkName } from '@ai-bounties/contracts'
import { createLlmFromEnv } from '@ai-bounties/llm'
import { createApp } from './app.js'
import { BountyStore } from './store/bountyStore.js'
import { AccountStore } from './store/accountStore.js'
import { BondStore } from './store/bondStore.js'
import { ChallengeStore, SessionStore } from './store/sessionStore.js'
import { StripeEventStore } from './store/stripeEventStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../../..')
loadEnv({ path: path.join(rootDir, '.env') })

// Use AI_BOUNTIES_PORT only — ignore generic shell PORT (often set to 4000 etc.)
// so Vite's proxy to :8787 stays aligned.
const PORT = Number(process.env.AI_BOUNTIES_PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const NETWORK = (process.env.NETWORK ?? process.env.BSV_NETWORK ?? 'test') as Network
const DATA_DIR = path.resolve(rootDir, process.env.DATA_DIR ?? './data')

const bountyStore = new BountyStore(DATA_DIR)
const accountStore = new AccountStore(DATA_DIR)
const sessionStore = new SessionStore(DATA_DIR)
const challengeStore = new ChallengeStore()
const bondStore = new BondStore(DATA_DIR)
const stripeEventStore = new StripeEventStore(DATA_DIR)

await bountyStore.init()
await accountStore.init()
await sessionStore.init()
await bondStore.init()
await stripeEventStore.init()

const app = createApp({
  publicUrl: PUBLIC_URL,
  webOrigins: [WEB_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
  network: NETWORK,
  llm: createLlmFromEnv(),
  stores: {
    bounties: bountyStore,
    accounts: accountStore,
    sessions: sessionStore,
    challenges: challengeStore,
    bonds: bondStore,
    stripeEvents: stripeEventStore,
  },
})

console.log(`AI Bounties API listening on http://${HOST}:${PORT}`)
console.log(`  OpenAPI:  ${PUBLIC_URL}/openapi.json`)
console.log(`  Agent:    ${PUBLIC_URL}/.well-known/agent.json`)
console.log(`  Data:     ${DATA_DIR}`)
console.log(`  Network:  ${NETWORK}`)
console.log(`  Phase:    6 (verifiable work + auto-release)`)
console.log(`  Escrow:   ${escrowMode()} (artifact=${isScryptArtifactAvailable()})`)

serve({ fetch: app.fetch, port: PORT, hostname: HOST })
