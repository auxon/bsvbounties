import { Hono } from 'hono'
import { z } from 'zod'
import {
  BRC100_LABELS,
  LLM_ARBITER_PUBKEY,
  VERIFIER_PUBKEY,
  buildPostActionOutputs,
  categoryFromLabel,
  contentHash,
  defaultAcceptance,
  generateBountyId,
  initMilestones,
  isAutoRelease,
  isSoftVerification,
  parseAcceptance,
  sha256Hex,
  validateMilestones,
  type AcceptanceSpec,
  type ArbiterMode,
  type Bounty,
  type BountyEscrowMeta,
  type Milestone,
  type Network,
} from '@ai-bounties/shared'
import {
  applyTransition,
  bountyStatusFromEscrow,
  buildDeployEscrowTemplate,
  buildScryptDeployTemplate,
  buildTransitionTemplate,
  canUseScryptEscrow,
  escrowMode,
  escrowStateFromBountyStatus,
  getArtifactMeta,
  initialSnapshot,
  isScryptArtifactAvailable,
  type EscrowSnapshot,
  type EscrowMethod,
  EscrowState,
} from '@ai-bounties/contracts'
import type { LlmClient } from '@ai-bounties/llm'
import type { BountyStore } from '../store/bountyStore.js'
import type { AccountStore } from '../store/accountStore.js'
import type { SessionStore } from '../store/sessionStore.js'
import type { BondStore } from '../store/bondStore.js'
import type { StripeEventStore } from '../store/stripeEventStore.js'
import {
  checkoutIntegrationIdentifier,
  type StripeAdapter,
} from '../stripe/client.js'
import { bsvUsdFromEnv, quoteCardCharge, usdFeePercent } from '../stripe/quote.js'
import { getSessionFromRequest } from './auth.js'
import { bondGate, workerBondGate } from './bonds.js'
import { runBountyVerifier, runLlmArbiter } from '../verifyFlow.js'

export type BountyStripeContext = {
  adapter: StripeAdapter | null
  events: StripeEventStore
  returnBase: string
}

const acceptanceSchema = z
  .object({
    kind: z.enum(['manual', 'http', 'schema', 'command', 'hash', 'llm-judge']),
  })
  .passthrough()

const milestoneSchema = z.object({
  title: z.string().max(120).optional(),
  amountSats: z.number().int().positive(),
  acceptance: acceptanceSchema,
})

const createSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(8000),
  category: z.string().default('other'),
  requirements: z.array(z.string()).optional(),
  amountSats: z.number().int().positive(),
  posterPubKey: z.string().optional(),
  posterAccount: z.number().int().positive().optional(),
  /** Legacy Phase 1: simple P2PKH hold without escrow meta. */
  posterLockingScriptHex: z.string().optional(),
  /** Phase 3: deploy full escrow (state machine + param OP_RETURN). */
  useEscrow: z.boolean().optional().default(true),
  arbiterPubKey: z.string().optional(),
  arbiter: z.union([z.literal('llm'), z.string()]).optional(),
  acceptance: acceptanceSchema.optional(),
  milestones: z.array(milestoneSchema).optional(),
  /** Unix timestamp or block height; 0 = no timed refund. */
  deadline: z.number().int().nonnegative().optional(),
  feeBps: z.number().int().min(0).max(1000).optional(),
  feePkh: z.string().optional(),
  escrowTxid: z.string().optional(),
  network: z.enum(['main', 'test']).optional(),
})

const claimSchema = z.object({
  workerPubKey: z.string().min(4).optional(),
  workerAccount: z.number().int().positive().optional(),
  claimTxid: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
})

const submitSchema = z
  .object({
    workHash: z.string().min(16).optional(),
    workUri: z.string().optional(),
    notes: z.string().max(4000).optional(),
    submitTxid: z.string().optional(),
    milestoneIndex: z.number().int().nonnegative().optional(),
  })
  .refine((d) => Boolean(d.workHash || d.workUri || d.notes), {
    message: 'workHash_or_workUri_required',
  })

const settleSchema = z.object({
  outcome: z.enum(['paid', 'refunded']),
  settleTxid: z.string().optional(),
  workerAddress: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
  feeLockingScriptHex: z.string().optional(),
})

const escrowActionSchema = z.object({
  signerPubKey: z.string().min(4),
  workerPubKey: z.string().optional(),
  workHash: z.string().optional(),
  payWorker: z.boolean().optional(),
  now: z.number().optional(),
  posterLockingScriptHex: z.string().optional(),
  workerLockingScriptHex: z.string().optional(),
  feeLockingScriptHex: z.string().optional(),
  txid: z.string().optional(),
  asVerifier: z.boolean().optional(),
})

function defaultFeeBps(): number {
  return Number(process.env.PLATFORM_FEE_BPS ?? 200)
}

function defaultFeePkh(): string {
  return process.env.PLATFORM_FEE_PKH ?? ''
}

function snapshotFromBounty(b: Bounty): EscrowSnapshot | null {
  if (b.escrow) {
    return {
      state: b.escrow.state as EscrowState,
      amountSats: b.amountSats,
      bountyId: b.id,
      contentHash: b.contentHash,
      posterPubKey: b.escrow.posterPubKey || b.posterPubKey || '',
      workerPubKey: b.escrow.workerPubKey || b.workerPubKey || '',
      arbiterPubKey: b.escrow.arbiterPubKey || '',
      deadline: b.escrow.deadline,
      workHash: b.workHash || '',
      feeBps: b.escrow.feeBps,
      feePkh: b.escrow.feePkh,
    }
  }
  if (!b.posterPubKey) return null
  return {
    state: escrowStateFromBountyStatus(b.status) as EscrowState,
    amountSats: b.amountSats,
    bountyId: b.id,
    contentHash: b.contentHash,
    posterPubKey: b.posterPubKey,
    workerPubKey: b.workerPubKey || '',
    arbiterPubKey: '',
    deadline: 0,
    workHash: b.workHash || '',
    feeBps: 0,
    feePkh: '',
  }
}

function metaFromSnapshot(
  s: EscrowSnapshot,
  mode: BountyEscrowMeta['mode'],
  extra?: Partial<BountyEscrowMeta>,
): BountyEscrowMeta {
  return {
    mode,
    state: s.state,
    posterPubKey: s.posterPubKey,
    workerPubKey: s.workerPubKey,
    arbiterPubKey: s.arbiterPubKey,
    deadline: s.deadline,
    feeBps: s.feeBps,
    feePkh: s.feePkh,
    ...extra,
  }
}

export function bountyRoutes(
  store: BountyStore,
  defaultNetwork: Network,
  accounts?: AccountStore,
  sessions?: SessionStore,
  bonds?: BondStore,
  llm?: LlmClient,
  stripe?: BountyStripeContext,
) {
  const app = new Hono()
  const requireAccounts = process.env.REQUIRE_ACCOUNT_FOR_CLAIM === 'true'

  app.get('/', (c) => {
    const status = c.req.query('status') as Bounty['status'] | undefined
    const category = c.req.query('category') ?? undefined
    const limit = Number(c.req.query('limit') ?? 50)
    const offset = Number(c.req.query('offset') ?? 0)
    const items = store.list({ status, category, limit, offset })
    return c.json({
      items,
      total: store.count(status),
      limit,
      offset,
    })
  })

  app.get('/:id', (c) => {
    const b = store.get(c.req.param('id'))
    if (!b) return c.json({ error: 'not_found' }, 404)
    return c.json(b)
  })

  app.get('/:id/escrow', (c) => {
    const b = store.get(c.req.param('id'))
    if (!b) return c.json({ error: 'not_found' }, 404)
    const snap = snapshotFromBounty(b)
    let artifact: unknown = null
    try {
      artifact = getArtifactMeta()
    } catch {
      /* no artifact */
    }
    return c.json({
      bountyId: b.id,
      status: b.status,
      escrow: b.escrow ?? null,
      snapshot: snap,
      contract: {
        version: 2,
        source: 'packages/contracts/src/contracts/bountyEscrow.ts',
        escrowMode: escrowMode(),
        artifactAvailable: isScryptArtifactAvailable(),
        artifact,
        note: 'Compiled BountyEscrow artifact used when ESCROW_MODE=scrypt and posterPubKey is a real compressed key.',
      },
    })
  })

  /**
   * Create / register a bounty with optional Phase 3 escrow deploy template.
   * Requires a logged-in session (Bearer from POST /v1/auth/login).
   */
  app.post('/', async (c) => {
    const body = createSchema.parse(await c.req.json())

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined
    if (!session || !accounts) {
      return c.json(
        {
          error: 'unauthorized',
          note: 'Login required to post a bounty. Mint an account, then POST /v1/auth/challenge → /v1/auth/login and send Authorization: Bearer <token>.',
        },
        401,
      )
    }

    const owned = accounts.getByNumber(session.accountNumber)
    if (!owned || owned.controllerKey !== session.controllerKey) {
      return c.json(
        {
          error: 'stale_session',
          note: 'Account ownership changed. Log in again.',
        },
        401,
      )
    }

    const posterAccount = session.accountNumber
    const posterPubKey = session.controllerKey

    const id = generateBountyId()
    const now = new Date().toISOString()
    const acceptance = parseAcceptance(body.acceptance ?? defaultAcceptance())
    const milestoneErr = validateMilestones(
      body.amountSats,
      body.milestones?.map((m) => ({
        title: m.title,
        amountSats: m.amountSats,
        acceptance: parseAcceptance(m.acceptance),
      })),
    )
    if (milestoneErr) {
      return c.json({ error: milestoneErr }, 400)
    }
    const milestones = body.milestones?.length
      ? initMilestones(
          body.milestones.map((m) => ({
            title: m.title,
            amountSats: m.amountSats,
            acceptance: parseAcceptance(m.acceptance),
          })),
        )
      : undefined

    let arbiterMode: ArbiterMode = 'none'
    let arbiterPubKey = body.arbiterPubKey
    if (body.arbiter === 'llm' || arbiterPubKey === 'llm') {
      arbiterMode = 'llm'
      arbiterPubKey = LLM_ARBITER_PUBKEY
    } else if (body.arbiter && body.arbiter !== 'llm') {
      arbiterMode = 'pubkey'
      arbiterPubKey = arbiterPubKey || body.arbiter
    } else if (arbiterPubKey) {
      arbiterMode = 'pubkey'
    }

    const hash = contentHash({
      version: 1,
      title: body.title,
      description: body.description,
      category: body.category,
      requirements: body.requirements,
      acceptance,
      milestones: body.milestones?.map((m) => ({
        title: m.title,
        amountSats: m.amountSats,
        acceptance: parseAcceptance(m.acceptance),
      })),
    })

    if (bonds) {
      const gate = bondGate(bonds, posterPubKey)
      if (!gate.ok) {
        return c.json(
          {
            error: gate.error,
            minBondSats: gate.minBondSats,
            note: `Deposit a poster bond of at least ${gate.minBondSats} sats via POST /v1/bonds/deposit (REQUIRE_POSTER_BOND=true).`,
          },
          403,
        )
      }
    }

    const useEscrow = body.useEscrow !== false
    let escrow: BountyEscrowMeta | undefined
    let createActionTemplate: unknown = null
    let note: string

    if (useEscrow && posterPubKey) {
      const snap = initialSnapshot({
        bountyId: id,
        contentHash: hash,
        amountSats: body.amountSats,
        posterPubKey,
        arbiterPubKey,
        deadline: body.deadline,
        feeBps: body.feeBps ?? defaultFeeBps(),
        feePkh: body.feePkh ?? defaultFeePkh(),
      })
      const wantScrypt = escrowMode() === 'scrypt' && canUseScryptEscrow()
      // Only use covenant locking script when posterPubKey is a real compressed key
      const realPubkey =
        /^0[23][0-9a-fA-F]{64}$/.test(posterPubKey.replace(/^0x/, '')) ||
        /^[0-9a-fA-F]{66}$/.test(posterPubKey.replace(/^0x/, ''))

      if (wantScrypt && realPubkey) {
        try {
          escrow = metaFromSnapshot(snap, 'scrypt')
          createActionTemplate = buildScryptDeployTemplate({
            snapshot: snap,
            title: body.title,
            category: body.category,
          })
          note =
            'sCrypt BountyEscrow deploy template (compiled artifact). Broadcast with funded BRC-100 wallet on NETWORK=test|main, then PATCH /escrow.'
        } catch (e) {
          console.warn('scrypt deploy template failed, falling back', e)
          escrow = metaFromSnapshot(snap, 'p2pkh')
          createActionTemplate = buildDeployEscrowTemplate({
            snapshot: snap,
            title: body.title,
            category: body.category,
            posterLockingScriptHex: body.posterLockingScriptHex,
          })
          note =
            'Fallback P2PKH escrow template (scrypt build failed or invalid key).'
        }
      } else {
        escrow = metaFromSnapshot(snap, wantScrypt ? 'scrypt' : 'p2pkh')
        createActionTemplate = buildDeployEscrowTemplate({
          snapshot: snap,
          title: body.title,
          category: body.category,
          posterLockingScriptHex: body.posterLockingScriptHex,
        })
        note = wantScrypt
          ? 'ESCROW_MODE=scrypt but posterPubKey is not a compressed EC key — using P2PKH hold + state machine. Pass a real pubkey (33-byte hex) for covenant lock.'
          : 'App-enforced escrow deploy template. Set ESCROW_MODE=scrypt + real posterPubKey for covenant locking script.'
      }
    } else if (body.posterLockingScriptHex) {
      createActionTemplate = {
        description: `Post AI Bounty: ${body.title}`,
        labels: [BRC100_LABELS.app, BRC100_LABELS.post],
        outputs: buildPostActionOutputs({
          amountSats: body.amountSats,
          posterLockingScriptHex: body.posterLockingScriptHex,
          post: {
            bountyId: id,
            amountSats: body.amountSats,
            contentHash: hash,
            category: categoryFromLabel(body.category),
            title: body.title,
          },
        }),
      }
      note =
        'Phase 1 P2PKH template. Prefer useEscrow=true for Phase 3 state machine.'
    } else {
      note =
        'Indexed off-chain only. Provide posterPubKey (and login) for escrow deploy template.'
    }

    const bounty: Bounty = {
      id,
      title: body.title,
      description: body.description,
      category: body.category.toLowerCase(),
      requirements: body.requirements ?? [],
      amountSats: body.amountSats,
      contentHash: hash,
      status: 'open',
      posterPubKey,
      posterAccount,
      escrowTxid: body.escrowTxid,
      escrow,
      acceptance,
      arbiterMode,
      milestones,
      currentMilestone: milestones?.length ? 0 : undefined,
      releasedSats: 0,
      createdAt: now,
      updatedAt: now,
      network: body.network ?? defaultNetwork,
    }

    await store.create(bounty)
    if (posterAccount != null && accounts) {
      await accounts.bumpStat(posterAccount, 'bountiesPosted')
    }

    return c.json({ bounty, createActionTemplate, note }, 201)
  })

  app.patch('/:id/escrow', async (c) => {
    const body = z
      .object({
        escrowTxid: z.string().min(8),
        outpoint: z.string().optional(),
      })
      .parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined
    if (!session) {
      return c.json(
        {
          error: 'unauthorized',
          note: 'Login required to attach escrowTxid. Send Authorization: Bearer <token>.',
        },
        401,
      )
    }
    const posterKey =
      existing.posterPubKey || existing.escrow?.posterPubKey || ''
    if (posterKey && session.controllerKey !== posterKey) {
      return c.json(
        {
          error: 'forbidden',
          note: 'Only the bounty poster session may attach escrowTxid.',
        },
        403,
      )
    }

    const escrow = existing.escrow
      ? {
          ...existing.escrow,
          lastTxid: body.escrowTxid,
          outpoint: body.outpoint ?? `${body.escrowTxid}:0`,
        }
      : undefined
    const updated = await store.update(c.req.param('id'), {
      escrowTxid: body.escrowTxid,
      escrow,
      funding: {
        ...existing.funding,
        method: 'bsv',
        status: 'funded',
        fundedAt: existing.funding?.fundedAt ?? new Date().toISOString(),
      },
    })
    return c.json(updated)
  })

  /**
   * Hosted Stripe Checkout (USD card) for a bounty the poster already created.
   * Same auth as POST /v1/bounties. Marks funded only via webhook.
   */
  app.post('/:id/checkout', async (c) => {
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined
    if (!session) {
      return c.json(
        {
          error: 'unauthorized',
          note: 'Login required to fund with a card. Send Authorization: Bearer <token> (same session as POST /v1/bounties).',
        },
        401,
      )
    }
    const posterKey =
      existing.posterPubKey || existing.escrow?.posterPubKey || ''
    if (posterKey && session.controllerKey !== posterKey) {
      return c.json(
        {
          error: 'forbidden',
          note: 'Only the bounty poster session may start card checkout.',
        },
        403,
      )
    }

    if (existing.funding?.status === 'funded' || existing.escrowTxid) {
      return c.json(
        {
          error: 'already_funded',
          note: 'This bounty is already funded (card webhook or BSV escrowTxid).',
        },
        409,
      )
    }
    if (['paid', 'refunded', 'cancelled'].includes(existing.status)) {
      return c.json(
        { error: 'invalid_status', status: existing.status },
        409,
      )
    }

    if (!stripe?.adapter) {
      return c.json(
        {
          error: 'stripe_not_configured',
          note: 'Set STRIPE_SECRET_KEY (wrangler secret) to enable Fund with card.',
        },
        503,
      )
    }
    const bsvUsd = bsvUsdFromEnv()
    if (bsvUsd == null) {
      return c.json(
        {
          error: 'bsv_usd_rate_missing',
          note: 'Set BSV_USD (USD per BSV) to convert the sat amount into a USD Checkout charge.',
        },
        503,
      )
    }

    const quote = quoteCardCharge({
      amountSats: existing.amountSats,
      bsvUsd,
    })
    const integrationIdentifier = checkoutIntegrationIdentifier()
    const returnBase = stripe.returnBase.replace(/\/$/, '')
    const created = await stripe.adapter.createCheckoutSession({
      bounty: existing,
      quote,
      successUrl: `${returnBase}/?checkout=success&bounty=${encodeURIComponent(existing.id)}`,
      cancelUrl: `${returnBase}/?checkout=cancel&bounty=${encodeURIComponent(existing.id)}`,
      integrationIdentifier,
    })

    await store.update(existing.id, {
      funding: {
        method: 'card',
        status: 'pending',
        stripeCheckoutSessionId: created.id,
        amountUsdCents: quote.totalUsdCents,
        amountSats: existing.amountSats,
        bsvUsd,
        usdFeeBps: quote.usdFeeBps,
        integrationIdentifier,
      },
    })

    return c.json({
      url: created.url,
      sessionId: created.id,
      bountyId: existing.id,
      ...quote,
      usdFeePercent: usdFeePercent(quote.usdFeeBps),
      integrationIdentifier,
      note:
        'Redirect the poster to `url` (hosted Stripe Checkout). ' +
        'Funding is confirmed by POST /v1/stripe/webhook on checkout.session.completed. ' +
        `USD fee ${usdFeePercent(quote.usdFeeBps)} + $${(quote.fixedFeeCents / 100).toFixed(2)}; ` +
        'sat payout fee is unchanged (PLATFORM_FEE_BPS).',
    })
  })

  async function runEscrowMethod(
    bountyId: string,
    method: EscrowMethod,
    body: z.infer<typeof escrowActionSchema>,
    sessionWorker?: { workerPubKey?: string; workerAccount?: number },
  ) {
    const existing = store.get(bountyId)
    if (!existing) return { error: 'not_found' as const, status: 404 as const }
    const snap = snapshotFromBounty(existing)
    if (!snap) {
      return {
        error: 'no_escrow' as const,
        status: 400 as const,
        note: 'Bounty has no escrow snapshot; recreate with useEscrow + posterPubKey.',
      }
    }

    const signer = body.signerPubKey
    const result = applyTransition(snap, {
      method,
      signerPubKey: signer,
      workerPubKey: body.workerPubKey ?? sessionWorker?.workerPubKey,
      workHash: body.workHash,
      payWorker: body.payWorker,
      now: body.now,
      asVerifier: body.asVerifier,
    })

    if (!result.ok) {
      return { error: result.error, status: 409 as const }
    }

    const template = buildTransitionTemplate({
      current: snap,
      transition: result,
      method,
      posterLockingScriptHex: body.posterLockingScriptHex,
      workerLockingScriptHex: body.workerLockingScriptHex,
      feeLockingScriptHex: body.feeLockingScriptHex,
    })

    const nextStatus = bountyStatusFromEscrow(result.next.state) as Bounty['status']
    const escrow = metaFromSnapshot(result.next, existing.escrow?.mode ?? 'scrypt', {
      lastTxid: body.txid,
      outpoint: body.txid ? `${body.txid}:0` : existing.escrow?.outpoint,
    })

    const patch: Partial<Bounty> = {
      status: nextStatus,
      escrow,
      workerPubKey: result.next.workerPubKey || existing.workerPubKey,
      workHash: result.next.workHash || existing.workHash,
    }
    if (sessionWorker?.workerAccount != null) {
      patch.workerAccount = sessionWorker.workerAccount
    }
    if (method === 'claim') {
      patch.claimedAt = existing.claimedAt ?? new Date().toISOString()
    }
    if (nextStatus === 'paid' || nextStatus === 'refunded') {
      patch.settleTxid = body.txid
    }

    const updated = await store.update(existing.id, patch)
    return {
      bounty: updated,
      transition: result,
      createActionTemplate: template,
      labels: template.labels,
    }
  }

  app.post('/:id/claim', async (c) => {
    const body = claimSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined

    let workerAccount = body.workerAccount
    let workerPubKey = body.workerPubKey

    if (session) {
      workerAccount = session.accountNumber
      workerPubKey = session.controllerKey
    }

    if (requireAccounts && workerAccount == null) {
      return c.json(
        {
          error: 'account_required',
          note: 'Mint + login to claim bounties (REQUIRE_ACCOUNT_FOR_CLAIM=true).',
        },
        401,
      )
    }

    if (workerAccount != null && accounts) {
      const acc = accounts.getByNumber(workerAccount)
      if (!acc) return c.json({ error: 'invalid_worker_account' }, 400)
      workerPubKey = workerPubKey ?? acc.controllerKey
    }

    if (!workerPubKey) {
      return c.json({ error: 'worker_identity_required' }, 400)
    }

    if (bonds) {
      const gate = workerBondGate(bonds, workerPubKey)
      if (!gate.ok) {
        return c.json(
          {
            error: gate.error,
            minBondSats: gate.minBondSats,
            note: `Deposit a worker bond of at least ${gate.minBondSats} sats via POST /v1/bonds/deposit with role=worker.`,
          },
          403,
        )
      }
    }

    // Phase 3 path when escrow meta present
    if (existing.escrow) {
      const action = await runEscrowMethod(
        existing.id,
        'claim',
        {
          signerPubKey: workerPubKey,
          workerPubKey,
          txid: body.claimTxid,
          workerLockingScriptHex: body.workerLockingScriptHex,
        },
        { workerPubKey, workerAccount },
      )
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (workerAccount != null && accounts) {
        await accounts.bumpStat(workerAccount, 'bountiesClaimed')
      }
      return c.json(action)
    }

    // Legacy Phase 1/2 claim
    if (existing.status !== 'open') {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: 'claimed',
      workerPubKey,
      workerAccount: workerAccount ?? undefined,
      claimedAt: existing.claimedAt ?? new Date().toISOString(),
    })
    if (workerAccount != null && accounts) {
      await accounts.bumpStat(workerAccount, 'bountiesClaimed')
    }
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.claim],
    })
  })

  async function recordWorkerVerify(
    bounty: Bounty,
    passed: boolean,
    fraud?: boolean,
    reason?: string,
  ) {
    if (bounty.workerAccount != null && accounts) {
      await accounts.bumpStat(
        bounty.workerAccount,
        passed ? 'verifiesPassed' : 'verifiesFailed',
      )
      if (bounty.claimedAt) {
        const ms = Date.now() - new Date(bounty.claimedAt).getTime()
        if (Number.isFinite(ms) && ms >= 0) {
          await accounts.recordSubmitDuration(bounty.workerAccount, ms)
        }
      }
    }
    if (!passed && fraud && bonds && bounty.workerPubKey) {
      const slashed = await bonds.slash(
        bounty.workerPubKey,
        reason ?? 'fraudulent_submission',
        'worker',
      )
      if (slashed && bounty.workerAccount != null && accounts) {
        await accounts.bumpStat(bounty.workerAccount, 'slashes')
      }
    }
  }

  async function autoApprove(bountyId: string) {
    return runEscrowMethod(bountyId, 'approve', {
      signerPubKey: VERIFIER_PUBKEY,
      asVerifier: true,
    })
  }

  app.post('/:id/submit', async (c) => {
    const body = submitSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const workHash =
      body.workHash ??
      sha256Hex(body.workUri ?? body.notes ?? existing.id)
    const milestoneIndex =
      body.milestoneIndex ?? existing.currentMilestone ?? 0
    const spec: AcceptanceSpec = existing.milestones?.length
      ? (existing.milestones[milestoneIndex]?.acceptance ??
        existing.acceptance ??
        defaultAcceptance())
      : (existing.acceptance ?? defaultAcceptance())

    if (existing.escrow) {
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer =
        session?.controllerKey ??
        existing.workerPubKey ??
        existing.escrow.workerPubKey
      if (!signer) return c.json({ error: 'worker_identity_required' }, 400)
      const action = await runEscrowMethod(existing.id, 'submit', {
        signerPubKey: signer,
        workHash,
        txid: body.submitTxid,
      })
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      const afterSubmit = await finishSubmit(
        existing.id,
        workHash,
        body.workUri,
        body.notes,
        milestoneIndex,
        spec,
        action,
      )
      return c.json(afterSubmit)
    }

    if (existing.status !== 'claimed' && existing.status !== 'submitted') {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    await store.update(existing.id, {
      status: 'submitted',
      workHash,
      workUri: body.workUri,
    })
    const afterSubmit = await finishSubmit(
      existing.id,
      workHash,
      body.workUri,
      body.notes,
      milestoneIndex,
      spec,
      {
        bounty: store.get(existing.id)!,
        labels: [BRC100_LABELS.app, BRC100_LABELS.submit],
      },
    )
    return c.json(afterSubmit)
  })

  async function finishSubmit(
    bountyId: string,
    workHash: string,
    workUri: string | undefined,
    notes: string | undefined,
    milestoneIndex: number,
    spec: AcceptanceSpec,
    action: Record<string, unknown> & { bounty?: Bounty },
  ) {
    let bounty = store.get(bountyId)!
    let milestones = bounty.milestones ? [...bounty.milestones] : undefined
    if (milestones?.[milestoneIndex]) {
      const m: Milestone = {
        ...milestones[milestoneIndex]!,
        status: 'submitted',
        workHash,
        workUri,
      }
      milestones[milestoneIndex] = m
    }

    const verification = await runBountyVerifier({
      bounty,
      acceptance: spec,
      workUri,
      workHash,
      notes,
      llm,
    })

    // Pass → paid. Soft waits (manual / LLM outage) and hard verify fails stay
    // "submitted" so the worker can resubmit or the poster can approve — never
    // mark a milestone "failed" while bounty status is still submitted.
    if (milestones?.[milestoneIndex]) {
      milestones[milestoneIndex] = {
        ...milestones[milestoneIndex]!,
        verification,
        status: verification.passed ? 'paid' : 'submitted',
      }
    }

    let releasedSats = bounty.releasedSats ?? 0
    let currentMilestone = milestoneIndex
    let autoReleased = false
    let approveAction: unknown = null

    if (spec.kind !== 'manual' && !isSoftVerification(verification)) {
      await recordWorkerVerify(
        bounty,
        verification.passed,
        verification.fraud,
        verification.reason,
      )
    }

    if (verification.passed) {
      if (milestones?.length) {
        releasedSats += milestones[milestoneIndex]?.amountSats ?? 0
        const remaining = milestones.some((m) => m.status !== 'paid')
        if (!remaining) {
          const paid = await tryAutoPay(bountyId, bounty)
          autoReleased = paid.autoReleased
          approveAction = paid.approveAction
          bounty = store.get(bountyId) ?? bounty
        } else {
          currentMilestone = milestones.findIndex((m) => m.status !== 'paid')
          if (currentMilestone < 0) currentMilestone = milestoneIndex + 1
        }
      } else if (isAutoRelease(spec)) {
        const paid = await tryAutoPay(bountyId, bounty)
        autoReleased = paid.autoReleased
        approveAction = paid.approveAction
        bounty = store.get(bountyId) ?? bounty
        if (autoReleased) releasedSats = bounty.amountSats
      }
    }

    const updated = await store.update(bountyId, {
      workUri,
      workHash,
      lastVerification: verification,
      milestones,
      releasedSats,
      currentMilestone,
    })
    bounty = updated ?? bounty

    return {
      ...action,
      bounty,
      verification,
      autoReleased,
      releasedSats,
      currentMilestone,
      approve: approveAction,
      note: autoReleased
        ? 'Verifier passed; escrow auto-approved.'
        : spec.kind === 'manual' || verification.reason === 'manual_approval_required'
          ? 'Submitted. Poster (or LLM arbiter) must approve.'
          : verification.passed
            ? milestones?.some((m) => m.status !== 'paid')
              ? 'Milestone passed; submit the next slice.'
              : 'Verified; awaiting poster approve (manual acceptance).'
            : isSoftVerification(verification)
              ? verification.reason === 'llm_credits_exhausted'
                ? 'LLM credits exhausted; work stays submitted (not failed). Resubmit later or ask the poster to approve.'
                : 'Verifier temporarily unavailable; work stays submitted. Resubmit later or ask the poster to approve.'
              : 'Verification failed; resubmit before the deadline or open a dispute.',
    }
  }

  async function tryAutoPay(bountyId: string, bounty: Bounty) {
    if (bounty.escrow) {
      const approveAction = await autoApprove(bountyId)
      if ('error' in approveAction && approveAction.error) {
        return { autoReleased: false, approveAction }
      }
      if (bounty.workerAccount != null && accounts) {
        await accounts.bumpStat(bounty.workerAccount, 'bountiesCompleted')
      }
      return { autoReleased: true, approveAction }
    }
    await store.update(bountyId, { status: 'paid' })
    if (bounty.workerAccount != null && accounts) {
      await accounts.bumpStat(bounty.workerAccount, 'bountiesCompleted')
    }
    return { autoReleased: true, approveAction: null }
  }

  app.post('/:id/settle', async (c) => {
    const body = settleSchema.parse(await c.req.json())
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)

    const session = sessions
      ? getSessionFromRequest(sessions, c.req.header('Authorization'))
      : undefined

    if (existing.escrow) {
      const signer =
        session?.controllerKey ??
        existing.posterPubKey ??
        existing.escrow.posterPubKey
      if (!signer) return c.json({ error: 'poster_identity_required' }, 400)
      if (session && session.controllerKey !== signer) {
        return c.json(
          {
            error: 'forbidden',
            note: 'Settle must use the poster session for this bounty.',
          },
          403,
        )
      }

      const method: EscrowMethod =
        body.outcome === 'paid' ? 'approve' : 'cancel'
      // refund uses deadline path when claimed; cancel only if open
      let action
      if (body.outcome === 'refunded' && existing.status !== 'open') {
        action = await runEscrowMethod(existing.id, 'refund', {
          signerPubKey: signer,
          txid: body.settleTxid,
          posterLockingScriptHex: undefined,
          workerLockingScriptHex: body.workerLockingScriptHex,
          feeLockingScriptHex: body.feeLockingScriptHex,
          now: Math.floor(Date.now() / 1000),
        })
        if ('error' in action && action.error === 'deadline_not_reached') {
          // Allow arbiter-less app-level refund for Phase 3 demo via cancel-style payout
          // only if still open; otherwise require deadline or resolve
          return c.json(
            {
              error: 'deadline_not_reached',
              note: 'Use POST /:id/escrow/resolve as arbiter, or wait for deadline.',
            },
            409,
          )
        }
      } else {
        action = await runEscrowMethod(existing.id, method, {
          signerPubKey: signer,
          txid: body.settleTxid,
          workerLockingScriptHex: body.workerLockingScriptHex,
          feeLockingScriptHex: body.feeLockingScriptHex,
        })
      }

      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (
        body.outcome === 'paid' &&
        existing.workerAccount != null &&
        accounts
      ) {
        await accounts.bumpStat(existing.workerAccount, 'bountiesCompleted')
      }
      if (
        body.outcome === 'refunded' &&
        existing.status !== 'open' &&
        bonds &&
        existing.workerPubKey
      ) {
        await slashWorker(
          existing.workerPubKey,
          existing.workerAccount,
          'no_submit_by_deadline',
        )
      }
      return c.json(action)
    }

    // Legacy / index-only bounties: poster session required to change board status.
    if (!session) {
      return c.json(
        {
          error: 'unauthorized',
          note: 'Login required to settle. Send Authorization: Bearer <token>.',
        },
        401,
      )
    }
    if (
      existing.posterPubKey &&
      session.controllerKey !== existing.posterPubKey
    ) {
      return c.json(
        {
          error: 'forbidden',
          note: 'Only the bounty poster session may settle this listing.',
        },
        403,
      )
    }

    if (!['claimed', 'submitted', 'open'].includes(existing.status)) {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }
    const updated = await store.update(existing.id, {
      status: body.outcome === 'paid' ? 'paid' : 'refunded',
      settleTxid: body.settleTxid,
    })
    if (
      body.outcome === 'paid' &&
      existing.workerAccount != null &&
      accounts
    ) {
      await accounts.bumpStat(existing.workerAccount, 'bountiesCompleted')
    }
    return c.json({
      bounty: updated,
      labels: [BRC100_LABELS.app, BRC100_LABELS.settle],
    })
  })

  async function slashWorker(
    controllerKey: string,
    accountNumber: number | undefined,
    reason: string,
  ) {
    if (!bonds) return
    const slashed = await bonds.slash(controllerKey, reason, 'worker')
    if (slashed && accountNumber != null && accounts) {
      await accounts.bumpStat(accountNumber, 'slashes')
    }
  }

  async function slashPoster(
    controllerKey: string | undefined,
    accountNumber: number | undefined,
    reason: string,
  ) {
    if (!bonds || !controllerKey) return
    const slashed = await bonds.slash(controllerKey, reason, 'poster')
    if (slashed && accountNumber != null && accounts) {
      await accounts.bumpStat(accountNumber, 'slashes')
    }
  }

  app.post('/:id/dispute', async (c) => {
    const body = z
      .object({
        reason: z.string().max(2000).optional(),
        payWorker: z.boolean().optional(),
      })
      .parse((await c.req.json().catch(() => ({}))) as object)
    const existing = store.get(c.req.param('id'))
    if (!existing) return c.json({ error: 'not_found' }, 404)
    if (!['claimed', 'submitted'].includes(existing.status)) {
      return c.json({ error: 'invalid_status', status: existing.status }, 409)
    }

    const mode = existing.arbiterMode ?? (existing.escrow?.arbiterPubKey === LLM_ARBITER_PUBKEY ? 'llm' : existing.escrow?.arbiterPubKey ? 'pubkey' : 'none')

    if (mode === 'llm') {
      if (!llm) return c.json({ error: 'llm_unavailable' }, 503)
      const judged = await runLlmArbiter({
        bounty: existing,
        reason: body.reason,
        llm,
      })
      const payWorker = judged.pass
      let action: Awaited<ReturnType<typeof runEscrowMethod>> | { bounty: Bounty }
      if (existing.escrow) {
        action = await runEscrowMethod(existing.id, 'resolve', {
          signerPubKey: LLM_ARBITER_PUBKEY,
          payWorker,
        })
        if ('error' in action && action.error) {
          return c.json({ ...action, judged }, action.status ?? 400)
        }
      } else {
        const updated = await store.update(existing.id, {
          status: payWorker ? 'paid' : 'refunded',
        })
        action = { bounty: updated! }
      }
      if (payWorker) {
        await slashPoster(
          existing.posterPubKey,
          existing.posterAccount,
          `llm_arbiter_worker ${judged.reason}`.slice(0, 500),
        )
        if (existing.workerAccount != null && accounts) {
          await accounts.bumpStat(existing.workerAccount, 'bountiesCompleted')
        }
      } else {
        await slashWorker(
          existing.workerPubKey ?? '',
          existing.workerAccount,
          `llm_arbiter_poster ${judged.reason}`.slice(0, 500),
        )
      }
      return c.json({
        ...action,
        judged,
        arbiter: 'llm',
        note: payWorker
          ? 'LLM arbiter paid the worker; poster bond slashed if active.'
          : 'LLM arbiter refunded the poster; worker bond slashed if active.',
      })
    }

    if (mode === 'pubkey' && existing.escrow) {
      if (body.payWorker === undefined) {
        return c.json(
          {
            error: 'pubkey_arbiter',
            note: 'Call POST /v1/bounties/:id/escrow/resolve with arbiter signerPubKey and payWorker.',
          },
          400,
        )
      }
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer =
        session?.controllerKey ?? existing.escrow.arbiterPubKey
      const action = await runEscrowMethod(existing.id, 'resolve', {
        signerPubKey: signer,
        payWorker: body.payWorker,
      })
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      return c.json(action)
    }

    return c.json(
      {
        error: 'no_arbiter',
        note: 'Create the bounty with arbiter: "llm" or an arbiterPubKey to dispute.',
      },
      400,
    )
  })

  // Explicit escrow methods (Phase 3)
  for (const method of [
    'claim',
    'submit',
    'approve',
    'cancel',
    'refund',
    'resolve',
  ] as EscrowMethod[]) {
    if (method === 'claim' || method === 'submit') continue // already have routes
    app.post(`/:id/escrow/${method}`, async (c) => {
      const body = escrowActionSchema.parse(await c.req.json())
      const session = sessions
        ? getSessionFromRequest(sessions, c.req.header('Authorization'))
        : undefined
      const signer = session?.controllerKey ?? body.signerPubKey
      const action = await runEscrowMethod(c.req.param('id'), method, {
        ...body,
        signerPubKey: signer,
      })
      if ('error' in action && action.error) {
        return c.json(action, action.status ?? 400)
      }
      if (
        method === 'approve' &&
        action.bounty?.workerAccount != null &&
        accounts
      ) {
        await accounts.bumpStat(action.bounty.workerAccount, 'bountiesCompleted')
      }
      if (
        method === 'refund' &&
        action.bounty?.workerPubKey &&
        bonds
      ) {
        await slashWorker(
          action.bounty.workerPubKey,
          action.bounty.workerAccount,
          'no_submit_by_deadline',
        )
      }
      return c.json(action)
    })
  }

  return app
}
