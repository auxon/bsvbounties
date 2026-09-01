# Acceptance scorecard (feature completeness)

Prove what works on a running stack with **BSV testnet** as “real world.” Score each capability:

| Score | Meaning |
|-------|---------|
| **Pass** | Works end-to-end as documented |
| **Demo-only** | API/UI advance, but no real chain / fake auth / mock LLM |
| **Gap** | Documented Phase feature missing from UI, MCP, or on-chain path |

Do **not** use mainnet for this pass. Defaults: `NETWORK=test`, `ESCROW_MODE=scrypt` (see [TESTNET.md](./TESTNET.md)).

## Prerequisites

```bash
cp .env.example .env   # if needed
npm install
npm run build:libs
npm run compile:contracts   # if artifacts missing
npm run dev                 # API :8787 + web :5173
```

Useful env (see `.env.example`):

| Var | Role |
|-----|------|
| `NETWORK` / `BSV_NETWORK` | `test` |
| `ESCROW_MODE` | `scrypt` for covenant templates |
| `BSV_TESTNET_WIF` | Server deploy / fund-info (never commit) |
| `XAI_API_KEY` | Real LLM; omit → mock |
| `REQUIRE_POSTER_BOND` | Exercise bond gate |
| `PLATFORM_ADMIN_SECRET` | Bond slash |
| `AI_BOUNTIES_API_URL` | MCP → API |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Card funding (see [STRIPE.md](./STRIPE.md)) |
| `BSV_USD` / `USD_FEE_BPS` | Sats→USD quote and documented USD fee % |

## How to run

```bash
# Tier 0
npm test
curl -s http://localhost:8787/health | jq

# Tier 1 — live API scorecard (no broadcast)
npm run accept:api

# Tier 2 — MCP agent path
npm run accept:mcp

# Tier 3 — on-chain helpers (needs funded BSV_TESTNET_WIF)
npm run accept:testnet
# When balance ≥ 2000 sats this runs deploy-demo. Then broadcast the API
# createActionTemplate with a testnet BRC-100 wallet and PATCH escrowTxid.
```

## Capability matrix

Fill **Result** during a run. Seeded expectations reflect known interim limits.

| Capability | Must exercise | Result | Notes |
|------------|---------------|--------|-------|
| Discovery | `/health`, `/openapi.json`, `/.well-known/agent.json` | Pass | Tier 1 `accept:api` |
| Bounty lifecycle | post → claim → submit → settle paid | Demo-only | App index advances without broadcast |
| Escrow cancel (API) | `POST …/escrow/cancel` while OPEN | Pass | |
| Escrow refund early | refund before deadline → `deadline_not_reached` | Pass | HTTP 409 |
| Escrow resolve (API) | arbiter `POST …/escrow/resolve` | Pass | Needs `arbiterPubKey` on create |
| Escrow UI edges | cancel / refund / resolve in web | Gap | Client has `escrowAction` but UI not wired |
| sCrypt deploy template | compressed `02`/`03` pubkey + `ESCROW_MODE=scrypt` | Pass | Authenticated create (session controller key = compressed pubkey) |
| Attach escrowTxid | `PATCH …/escrow` | Demo-only | Real txid blocked until faucet funds |
| Stripe Checkout (USD) | `POST …/checkout` + webhook `checkout.session.completed` | Pass (unit) | Hosted Checkout; no on-chain USD→BSV. See [STRIPE.md](./STRIPE.md) |
| Accounts mint / login / profile | challenge → demo sig → Bearer | Demo-only | `AUTH_MODE=demo` only |
| Marketplace list / buy | list + buy (optional `commit:false`) | Demo-only | Index can transfer without broadcast |
| Atomic swap template | `POST …/swap-template` outputs | Pass | 3 outputs; UI: Gap |
| Poster bonds | deposit + get; optional gate + slash | Demo-only / Pass | deposit template Demo-only; get Pass; UI Gap |
| LLM draft | `/v1/llm/draft-bounty` | Demo-only | Mock without usable key in last run |
| MCP lifecycle | mint → auth → bounty → claim → submit → settle | Pass | `accept:mcp` |
| MCP Phase 4 | bonds, marketplace, swap/buy | Pass | Extended `mcp-smoke.mjs` |
| Testnet deploy-demo | `testnet:deploy-demo` + WoC | Gap | Wallet balance 0; faucets down / need sign-in |
| Testnet bounty fund | broadcast deploy + attach + WoC | Gap | Same funding blocker |
| Covenant method-call settle | `instance.methods.*` via API | Gap | Not wired; templates + app SM only |

## Tier checklist

### Tier 0 — Baseline

- [x] `npm test` passes (shared + contracts)
- [x] `GET /health` → `network: test`, `escrowMode: scrypt`, `scryptArtifact: true`, `phase: 5`
- [x] API :8787 up (web optional for API/MCP tiers)

### Tier 1 — Feature matrix (API / demo wallet)

- [x] Run `npm run accept:api` — 11 pass / 8 demo-only / 4 gap / 0 fail
- [ ] Web: mint, login, post bounty, claim, submit, approve (demo wallet OK) — manual
- [x] Confirm UI Gap: no bonds / swap / escrow cancel-refund-resolve controls

### Tier 2 — MCP

- [x] `npm run accept:mcp` exits 0
- [x] Tools exercised: health, mint, auth, create/claim/submit/settle, draft, bonds, marketplace, swap, buy

### Tier 3 — Testnet on-chain

- [x] `npm run accept:testnet` / `GET /v1/chain` — balance **0** (blocked)
- [ ] `testnet:deploy-demo` — tx on https://test.whatsonchain.com
- [x] Create bounty with **real compressed** poster pubkey; template is sCrypt (not P2PKH fallback)
- [ ] Broadcast template; `PATCH` real `escrowTxid`; verify outpoint on WoC
- [x] Negative: demo `posterPubKey` → P2PKH fallback note (must not score as covenant Pass)
- [ ] Optional: claim/submit/approve templates broadcast; payouts on WoC
- [ ] Separate OPEN bounty: cancel → refund template

**Honest Tier 3 Pass:** deploy + attach + explorer-visible funding. Full covenant method-call settlement remains **Gap**.

**Funding:** send testnet sats to the address from `npm run accept:testnet` / `GET /v1/chain` (e.g. via https://bsvfaucet.com/), then re-run `npm run accept:testnet`.

## Known interim limits (do not fail the whole suite alone)

- Demo auth (`sha256(message:controllerKey)`), not ECDSA
- Demo wallet fake txids when no `window.bitcoin`
- App index can advance without broadcast
- sCrypt method-call spends not integrated into claim/approve API
- No web UI for bonds, atomic swap, or escrow cancel/refund/resolve
- Account token is 1-sat + OP_RETURN, not a 1Sat ordinal

## Last run log

| Date | Operator | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Blockers |
|------|----------|--------|--------|--------|--------|----------|
| 2026-08-01 | agent | Pass (13 unit) | Pass (0 fail) | Pass (mcp-smoke) | Partial — sCrypt template Pass; deploy/broadcast Gap | Testnet wallet `mqajYy2KmixaizcBSorSrTLdQdAuNfKSPG` balance 0; classic faucets 404/SSL; bsvfaucet.com needs sign-in |

Ship blockers: any **Gap** that README marks ✅ for the path under test (especially scrypt deploy with real pubkey, MCP lifecycle, account mint/login).
