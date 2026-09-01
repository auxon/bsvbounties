import type { Account, Bounty } from '@ai-bounties/shared'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

let authToken: string | null =
  typeof localStorage !== 'undefined' ? localStorage.getItem('aib_token') : null

export function setAuthToken(token: string | null) {
  authToken = token
  if (typeof localStorage !== 'undefined') {
    if (token) localStorage.setItem('aib_token', token)
    else localStorage.removeItem('aib_token')
  }
}

export function getAuthToken() {
  return authToken
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (authToken) headers.Authorization = `Bearer ${authToken}`

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(
      typeof err.error === 'string'
        ? err.error
        : err.note ?? res.statusText,
    )
  }
  return res.json() as Promise<T>
}

export interface ListResponse {
  items: Bounty[]
  total: number
}

export function listBounties(status?: string): Promise<ListResponse> {
  const q = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/v1/bounties${q}`)
}

export function createBounty(body: {
  title: string
  description: string
  category: string
  requirements?: string[]
  amountSats: number
  posterPubKey?: string
  posterAccount?: number
  posterLockingScriptHex?: string
  useEscrow?: boolean
  deadline?: number
  arbiterPubKey?: string
  arbiter?: 'llm' | string
  acceptance?: {
    kind: string
    url?: string
    jsonPath?: string
    expect?: string | number | boolean
    expectStatus?: number
    regex?: string
    contentTypePrefix?: string
    schema?: Record<string, unknown>
    rubric?: string
    prompt?: string
    expectedHash?: string
    passScore?: number
  }
  milestones?: Array<{
    title?: string
    amountSats: number
    acceptance: { kind: string; jsonPath?: string; expect?: unknown }
  }>
}): Promise<{
  bounty: Bounty
  createActionTemplate: {
    description: string
    labels: string[]
    outputs: Array<{ satoshis: number; lockingScript: string }>
  } | null
  note: string
}> {
  return request('/v1/bounties', {
    method: 'POST',
    body: JSON.stringify({ useEscrow: true, ...body }),
  })
}

export function claimBounty(
  id: string,
  opts?: { workerPubKey?: string; workerAccount?: number },
) {
  return request(`/v1/bounties/${id}/claim`, {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  })
}

export function submitWork(
  id: string,
  workHash: string | undefined,
  workUri?: string,
  notes?: string,
) {
  return request(`/v1/bounties/${id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ workHash, workUri, notes }),
  })
}

export function disputeBounty(id: string, reason?: string) {
  return request(`/v1/bounties/${id}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function settleBounty(
  id: string,
  outcome: 'paid' | 'refunded',
  settleTxid?: string,
) {
  return request(`/v1/bounties/${id}/settle`, {
    method: 'POST',
    body: JSON.stringify({ outcome, settleTxid }),
  })
}

export function escrowAction(
  id: string,
  method: 'approve' | 'cancel' | 'refund' | 'resolve',
  body: { signerPubKey: string; payWorker?: boolean; now?: number },
) {
  return request(`/v1/bounties/${id}/escrow/${method}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function draftBounty(roughIdea: string, category?: string) {
  return request<{
    draft: {
      title?: string
      description?: string
      category?: string
      requirements?: string[]
    } | string
    provider: string
    model: string
  }>('/v1/llm/draft-bounty', {
    method: 'POST',
    body: JSON.stringify({ roughIdea, category }),
  })
}

export function getLlmConfig() {
  return request<{ provider: string; model: string; configured: boolean }>(
    '/v1/llm/config',
  )
}

export function attachEscrow(id: string, escrowTxid: string) {
  return request(`/v1/bounties/${id}/escrow`, {
    method: 'PATCH',
    body: JSON.stringify({ escrowTxid }),
  })
}

export function createBountyCheckout(id: string) {
  return request<{
    url: string
    sessionId: string
    bountyId: string
    amountSats: number
    netUsdCents: number
    feeUsdCents: number
    totalUsdCents: number
    bsvUsd: number
    usdFeeBps: number
    usdFeePercent: string
    integrationIdentifier: string
    note: string
  }>(`/v1/bounties/${id}/checkout`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function getFundingConfig() {
  return request<{
    stripeConfigured: boolean
    bsvUsd: number | null
    usdFeeBps: number
    usdFeePercent: string
    satFeeBps: number
    satFeePercent: string
    stripeFixedFeeCents: number
    currency: string
    note: string
  }>('/v1/funding/config')
}

export function quoteFunding(amountSats: number) {
  return request<{
    amountSats: number
    bsvUsd: number
    netUsdCents: number
    feeUsdCents: number
    totalUsdCents: number
    usdFeeBps: number
    usdFeePercent: string
    satFeeBps: number
    satFeePercent: string
  }>(`/v1/funding/quote?amountSats=${encodeURIComponent(String(amountSats))}`)
}

// --- Accounts ---

export function listAccounts(forSale?: boolean) {
  const q = forSale ? '?forSale=true' : ''
  return request<{ items: Account[]; total: number }>(`/v1/accounts${q}`)
}

export function getMarketplace() {
  return request<{ items: Account[]; total: number }>(
    '/v1/accounts/marketplace',
  )
}

export function mintAccount(body: {
  controllerKey: string
  displayName?: string
  bio?: string
  kind?: 'human' | 'agent'
  preferredNumber?: number
  ownerLockingScriptHex?: string
}) {
  return request<{
    account: Account
    createActionTemplate: unknown
    note: string
  }>('/v1/accounts/mint', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listAccountForSale(number: number, priceSats: number) {
  return request<{ account: Account }>(`/v1/accounts/${number}/list`, {
    method: 'POST',
    body: JSON.stringify({ priceSats }),
  })
}

export function delistAccount(number: number) {
  return request<{ account: Account }>(`/v1/accounts/${number}/delist`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function transferAccount(
  number: number,
  toControllerKey: string,
  transferTxid?: string,
) {
  return request<{ account: Account }>(`/v1/accounts/${number}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ toControllerKey, transferTxid }),
  })
}

export function buyAccount(number: number, buyerControllerKey: string) {
  return request<{
    account: Account
    session: { token: string; expiresAt: string; accountNumber: number }
    paidSats: number
  }>(`/v1/accounts/${number}/buy`, {
    method: 'POST',
    body: JSON.stringify({ buyerControllerKey }),
  })
}

export function updateProfile(
  number: number,
  body: {
    displayName?: string
    bio?: string
    skills?: string[]
    capabilities?: string[]
    callback?: string
    kind?: 'human' | 'agent'
  },
) {
  return request<Account>(`/v1/accounts/${number}/profile`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

// --- Auth ---

export function authChallenge(controllerKey: string) {
  return request<{
    challenge: string
    message: string
    expiresAt: string
    authMode: string
  }>('/v1/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ controllerKey }),
  })
}

export function authLogin(body: {
  controllerKey: string
  challenge: string
  signature: string
  accountNumber?: number
}) {
  return request<{ token: string; expiresAt: string; account: Account }>(
    '/v1/auth/login',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
}

export function authMe() {
  return request<{
    session: { accountNumber: number; expiresAt: string; controllerKey: string }
    account: Account
  }>('/v1/auth/me')
}

export function authLogout() {
  return request<{ ok: boolean }>('/v1/auth/logout', { method: 'POST' })
}

/** Demo signature matching API AUTH_MODE=demo. */
export async function demoSign(
  message: string,
  controllerKey: string,
): Promise<string> {
  const data = new TextEncoder().encode(`${message}:${controllerKey}`)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
