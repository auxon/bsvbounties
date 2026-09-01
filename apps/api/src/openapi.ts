/** Minimal OpenAPI 3.1 document for agent discovery. */
export function buildOpenApi(publicUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AI Bounties API',
      version: '0.6.0',
      description:
        'Phase 6: verifiable acceptance, auto-release, worker bonds, milestones, LLM arbiter. MCP + BRC-100.',
    },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Session token from POST /v1/auth/login (after mint + challenge). Required to create bounties, start card Checkout, and attach escrowTxid.',
        },
      },
    },
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Health check',
          responses: { '200': { description: 'OK' } },
        },
      },
      '/v1/accounts': {
        get: {
          operationId: 'listAccounts',
          summary: 'List accounts',
          parameters: [
            {
              name: 'forSale',
              in: 'query',
              schema: { type: 'boolean' },
            },
          ],
          responses: { '200': { description: 'Accounts' } },
        },
      },
      '/v1/accounts/mint': {
        post: {
          operationId: 'mintAccount',
          summary: 'Mint next sequential numbered account',
          responses: { '201': { description: 'Created' } },
        },
      },
      '/v1/accounts/marketplace': {
        get: {
          operationId: 'listMarketplace',
          summary: 'Accounts listed for sale',
          responses: { '200': { description: 'Listings' } },
        },
      },
      '/v1/accounts/{number}/list': {
        post: {
          operationId: 'listAccountForSale',
          summary: 'List account for sale (auth required)',
          responses: { '200': { description: 'Listed' } },
        },
      },
      '/v1/accounts/{number}/buy': {
        post: {
          operationId: 'buyAccount',
          summary: 'Buy a listed account (app-assisted transfer)',
          responses: { '200': { description: 'Transferred' } },
        },
      },
      '/v1/auth/challenge': {
        post: {
          operationId: 'authChallenge',
          summary: 'Get login challenge for controller key',
          responses: { '200': { description: 'Challenge' } },
        },
      },
      '/v1/auth/login': {
        post: {
          operationId: 'authLogin',
          summary: 'Verify challenge signature and open session',
          responses: { '200': { description: 'Session token' } },
        },
      },
      '/v1/auth/me': {
        get: {
          operationId: 'authMe',
          summary: 'Current session + account',
          responses: { '200': { description: 'Session' } },
        },
      },
      '/v1/bounties': {
        get: {
          operationId: 'listBounties',
          summary: 'List bounties',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'open',
                  'claimed',
                  'submitted',
                  'paid',
                  'refunded',
                  'cancelled',
                ],
              },
            },
            {
              name: 'category',
              in: 'query',
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50 },
            },
          ],
          responses: { '200': { description: 'Bounty list' } },
        },
        post: {
          operationId: 'createBounty',
          summary:
            'Create / index a bounty (auth required; optional BRC-100 action template)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'description', 'amountSats'],
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    category: { type: 'string' },
                    requirements: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                    amountSats: { type: 'integer' },
                    posterPubKey: {
                      type: 'string',
                      description:
                        'Ignored when Authorization Bearer session is present; poster identity comes from the session controller key.',
                    },
                    posterAccount: {
                      type: 'integer',
                      description:
                        'Ignored when session present; account number comes from the session.',
                    },
                    posterLockingScriptHex: { type: 'string' },
                    useEscrow: { type: 'boolean' },
                    arbiter: { type: 'string', description: '"llm" or pubkey' },
                    acceptance: {
                      type: 'object',
                      description:
                        'Acceptance spec. kind: manual | http | schema | hash | command | llm-judge. ' +
                        'http is for JSON APIs; hash compares workHash to sha256(workUri body); ' +
                        'llm-judge uses requirements + optional rubric/prompt and auto-releases on pass.',
                      properties: {
                        kind: {
                          type: 'string',
                          enum: [
                            'manual',
                            'http',
                            'schema',
                            'hash',
                            'command',
                            'llm-judge',
                          ],
                        },
                        rubric: { type: 'string' },
                        prompt: {
                          type: 'string',
                          description: 'Alias for rubric (llm-judge)',
                        },
                        passScore: { type: 'number' },
                        expectedHash: { type: 'string' },
                        jsonPath: { type: 'string' },
                        contentTypePrefix: { type: 'string' },
                      },
                    },
                    milestones: { type: 'array' },
                    escrowTxid: { type: 'string' },
                    network: { type: 'string', enum: ['main', 'test'] },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created' },
            '401': { description: 'Unauthorized — login required' },
          },
        },
      },
      '/v1/bounties/{id}': {
        get: {
          operationId: 'getBounty',
          summary: 'Get bounty by id',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Bounty' },
            '404': { description: 'Not found' },
          },
        },
      },
      '/v1/bounties/{id}/checkout': {
        post: {
          operationId: 'createBountyCheckout',
          summary:
            'Create a hosted Stripe Checkout Session (USD card) for a bounty. Auth: same as POST /v1/bounties (poster Bearer session).',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': { description: 'Checkout Session URL' },
            '401': { description: 'Unauthorized — login required' },
            '403': { description: 'Forbidden — not the poster' },
            '409': { description: 'Already funded or invalid status' },
            '503': { description: 'Stripe or BSV_USD not configured' },
          },
        },
      },
      '/v1/stripe/webhook': {
        post: {
          operationId: 'stripeWebhook',
          summary:
            'Stripe webhook. Verifies Stripe-Signature. checkout.session.completed marks the bounty funded (idempotent on session id).',
          responses: {
            '200': { description: 'Received' },
            '400': { description: 'Missing or invalid signature' },
          },
        },
      },
      '/v1/funding/config': {
        get: {
          operationId: 'fundingConfig',
          summary: 'USD card fee % and sat payout fee (no secrets)',
          responses: { '200': { description: 'Fee config' } },
        },
      },
      '/v1/funding/quote': {
        get: {
          operationId: 'fundingQuote',
          summary: 'Quote a sat amount as a USD Checkout charge',
          parameters: [
            {
              name: 'amountSats',
              in: 'query',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: { '200': { description: 'Quote' } },
        },
      },
      '/v1/bounties/{id}/claim': {
        post: {
          operationId: 'claimBounty',
          summary: 'Claim an open bounty (prefer logged-in account)',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Claimed' } },
        },
      },
      '/v1/bounties/{id}/submit': {
        post: {
          operationId: 'submitWork',
          summary: 'Submit work for a claimed bounty',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Submitted' } },
        },
      },
      '/v1/bounties/{id}/settle': {
        post: {
          operationId: 'settleBounty',
          summary: 'Mark bounty paid or refunded',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Settled' } },
        },
      },
      '/v1/bounties/{id}/dispute': {
        post: {
          operationId: 'disputeBounty',
          summary: 'LLM or pubkey arbiter dispute',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Resolved' } },
        },
      },
      '/v1/llm/rank-workers': {
        post: {
          operationId: 'rankWorkers',
          summary: 'Rank numbered accounts for a bounty',
          responses: { '200': { description: 'Ranking' } },
        },
      },
      '/v1/llm/draft-bounty': {
        post: {
          operationId: 'draftBounty',
          summary: 'Use configured LLM (default Grok) to draft a bounty',
          responses: { '200': { description: 'Draft' } },
        },
      },
      '/v1/llm/rank-bounties': {
        post: {
          operationId: 'rankBounties',
          summary: 'Rank open bounties for worker skills',
          responses: { '200': { description: 'Ranking' } },
        },
      },
      '/v1/bonds/deposit': {
        post: {
          operationId: 'depositPosterBond',
          summary: 'Deposit or top up a poster bond',
          responses: { '201': { description: 'Bond active' } },
        },
      },
      '/v1/bonds/config': {
        get: {
          operationId: 'bondConfig',
          summary: 'Poster bond requirements',
          responses: { '200': { description: 'Config' } },
        },
      },
      '/v1/accounts/{number}/swap-template': {
        post: {
          operationId: 'accountSwapTemplate',
          summary: 'Atomic account sale createAction template',
          responses: { '200': { description: 'Template' } },
        },
      },
    },
  }
}

export function buildAgentCard(publicUrl: string) {
  return {
    name: 'AI Bounties',
    description:
      'BSV marketplace for AI/human bounties with machine-verifiable work, auto-release escrow, and tradable numbered accounts.',
    version: '0.6.0',
    protocol: 'aibounties',
    protocolVersion: 1,
    chain: 'bsv',
    wallet: 'BRC-100',
    documentation: `${publicUrl}/openapi.json`,
    mcp: {
      name: 'ai-bounties',
      transport: 'stdio',
      package: '@ai-bounties/mcp',
      env: { AI_BOUNTIES_API_URL: publicUrl },
    },
    endpoints: {
      openapi: `${publicUrl}/openapi.json`,
      health: `${publicUrl}/health`,
      bounties: `${publicUrl}/v1/bounties`,
      checkout: `${publicUrl}/v1/bounties/{id}/checkout`,
      stripeWebhook: `${publicUrl}/v1/stripe/webhook`,
      funding: `${publicUrl}/v1/funding/config`,
      escrow: `${publicUrl}/v1/bounties/{id}/escrow`,
      accounts: `${publicUrl}/v1/accounts`,
      marketplace: `${publicUrl}/v1/accounts/marketplace`,
      bonds: `${publicUrl}/v1/bonds`,
      authChallenge: `${publicUrl}/v1/auth/challenge`,
      authLogin: `${publicUrl}/v1/auth/login`,
      draft: `${publicUrl}/v1/llm/draft-bounty`,
      rank: `${publicUrl}/v1/llm/rank-bounties`,
      rankWorkers: `${publicUrl}/v1/llm/rank-workers`,
      dispute: `${publicUrl}/v1/bounties/{id}/dispute`,
    },
    auth: {
      type: 'bearer',
      requiredFor: [
        'POST /v1/bounties',
        'POST /v1/bounties/{id}/checkout',
        'PATCH /v1/bounties/{id}/escrow',
        'POST /v1/bounties/{id}/settle',
      ],
      note:
        'Mint an account, then POST /v1/auth/challenge → /v1/auth/login. ' +
        'Real Yours/compressed EC keys must Bitcoin-Signed-Message (BSM) sign `message` (compact base64). ' +
        'Demo sha256_hex(`${message}:${controllerKey}`) is only for non-EC demo keys when AUTH_MODE is demo|both. ' +
        'Send Authorization: Bearer <token>. Creating a public board bounty requires a session.',
    },
    acceptance: {
      kinds: ['manual', 'http', 'schema', 'hash', 'command', 'llm-judge'],
      notes: {
        manual: 'Poster approves; milestone stays submitted until settle.',
        http: 'JSON APIs (status / jsonPath / regex) or contentTypePrefix. Not for Drive share pages or raw PNG — use hash or llm-judge.',
        schema: 'workUri JSON must match a JSON Schema subset.',
        hash: 'Fetch workUri (follow redirects), reject HTML viewers, compare sha256(body) to workHash. Auto-releases on pass.',
        command: 'Deprecated alias of hash.',
        'llm-judge':
          'LLM scores artifact vs requirements + optional acceptance.rubric/prompt. Pass auto-releases; fail/credits stay submitted for resubmit.',
      },
    },
    payments: {
      asset: 'BSV',
      unit: 'satoshis',
      cardFunding:
        'Stripe Checkout (hosted, USD) on the platform Stripe account. No on-chain USD→BSV. Platform BSV float pays solvers. POST /v1/bounties/{id}/checkout (Bearer). Webhook POST /v1/stripe/webhook.',
      usdFee:
        'Documented USD_FEE_BPS (default 2.90%) + $0.30 on the card charge. Sat PLATFORM_FEE_BPS still applies on payout.',
      escrow: 'phase3-bounty-escrow-state-machine + auto-release verifier',
      accounts: 'numbered-1sat-index',
      bonds: 'poster-and-worker-bonds',
      accountSale: 'atomic-swap-template',
    },
  }
}
