import { useState } from 'react'
import {
  formatVerificationReason,
  isBountyFunded,
  type Bounty,
} from '@ai-bounties/shared'

function satsLabel(sats: number): string {
  if (sats >= 100_000_000) return `${(sats / 100_000_000).toFixed(4)} BSV`
  if (sats >= 1000) return `${(sats / 1000).toFixed(1)}k sats`
  return `${sats} sats`
}

function usdLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const ESCROW_STATE: Record<number, string> = {
  0: 'OPEN',
  1: 'CLAIMED',
  2: 'SUBMITTED',
  3: 'PAID',
  4: 'REFUNDED',
}

export function BountyCard({
  bounty,
  onClaim,
  onSubmit,
  onApprove,
  onDispute,
  onFundCard,
  posterAccountNumber,
  cardFundingEnabled,
}: {
  bounty: Bounty
  onClaim?: (id: string) => void
  onSubmit?: (id: string, workUri: string) => void
  onApprove?: (id: string) => void
  onDispute?: (id: string) => void
  onFundCard?: (id: string) => void
  posterAccountNumber?: number
  cardFundingEnabled?: boolean
}) {
  const [workUri, setWorkUri] = useState(bounty.workUri ?? '')
  const acceptKind = bounty.acceptance?.kind ?? 'manual'
  const released = bounty.releasedSats ?? 0
  const funded = isBountyFunded(bounty)
  const isPoster =
    posterAccountNumber != null && bounty.posterAccount === posterAccountNumber
  const canFundCard =
    Boolean(onFundCard) &&
    Boolean(cardFundingEnabled) &&
    isPoster &&
    !funded &&
    !['paid', 'refunded', 'cancelled'].includes(bounty.status)
  const workPlaceholder =
    acceptKind === 'http'
      ? 'JSON API URL — not Drive/PNG (use hash or llm-judge bounties for files)'
      : acceptKind === 'hash'
        ? 'Direct file URL (sha256 must match); Drive share pages are rejected'
        : 'https://… (Drive, GitHub, image, gist)'

  return (
    <article className="card">
      <div className="card-top">
        <span className={`badge status-${bounty.status}`}>{bounty.status}</span>
        <span className="badge category">{bounty.category}</span>
        <span className="badge accept" title="Acceptance">
          {acceptKind}
        </span>
        {bounty.arbiterMode && bounty.arbiterMode !== 'none' && (
          <span className="badge escrow">arbiter {bounty.arbiterMode}</span>
        )}
        {bounty.escrow && (
          <span className="badge escrow" title="Phase 3 escrow">
            escrow {ESCROW_STATE[bounty.escrow.state] ?? bounty.escrow.state}
          </span>
        )}
        {funded ? (
          <span
            className="badge funded"
            title={
              bounty.funding?.method === 'card'
                ? 'Funded with card (USD on platform Stripe; solvers paid from BSV float)'
                : 'Funded on-chain (BSV escrow)'
            }
          >
            {bounty.funding?.method === 'card' ? 'card funded' : 'funded'}
          </span>
        ) : bounty.funding?.status === 'pending' ? (
          <span className="badge unfunded">card pending</span>
        ) : (
          <span className="badge unfunded">unfunded</span>
        )}
        <span className="amount">{satsLabel(bounty.amountSats)}</span>
      </div>
      <h3>{bounty.title}</h3>
      <p className="desc">{bounty.description}</p>
      {bounty.requirements.length > 0 && (
        <ul className="reqs">
          {bounty.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {bounty.milestones && bounty.milestones.length > 0 && (
        <p className="muted small">
          Milestones: {bounty.milestones.filter((m) => m.status === 'paid').length}/
          {bounty.milestones.length} paid
          {released > 0 ? ` · ${satsLabel(released)} released` : ''}
        </p>
      )}
      {bounty.lastVerification && (
        <p className={bounty.lastVerification.passed ? 'ok' : 'err'}>
          Verify: {bounty.lastVerification.passed ? 'pass' : 'fail'} —{' '}
          {formatVerificationReason(bounty.lastVerification)}
        </p>
      )}
      <div className="card-meta">
        <code title={bounty.id}>{bounty.id.slice(0, 10)}…</code>
        {bounty.posterAccount != null && (
          <span className="acct">poster #{bounty.posterAccount}</span>
        )}
        {bounty.workerAccount != null && (
          <span className="acct">worker #{bounty.workerAccount}</span>
        )}
        {bounty.escrow?.feeBps != null && bounty.escrow.feeBps > 0 && (
          <span className="txid">fee {bounty.escrow.feeBps} bps</span>
        )}
        {bounty.escrowTxid && (
          <span className="txid" title={bounty.escrowTxid}>
            tx {bounty.escrowTxid.slice(0, 8)}…
          </span>
        )}
        {bounty.funding?.method === 'card' && bounty.funding.amountUsdCents != null && (
          <span className="txid">
            card {usdLabel(bounty.funding.amountUsdCents)}
          </span>
        )}
      </div>
      {(bounty.status === 'claimed' || bounty.status === 'submitted') && onSubmit && (
        <label className="work-uri">
          Work URI
          <input
            value={workUri}
            onChange={(e) => setWorkUri(e.target.value)}
            placeholder={workPlaceholder}
          />
        </label>
      )}
      <div className="card-actions">
        {canFundCard && (
          <button
            type="button"
            className="btn secondary"
            onClick={() => onFundCard?.(bounty.id)}
          >
            Fund with card
          </button>
        )}
        {bounty.status === 'open' && onClaim && (
          <button type="button" className="btn secondary" onClick={() => onClaim(bounty.id)}>
            Claim
          </button>
        )}
        {(bounty.status === 'claimed' || bounty.status === 'submitted') && onSubmit && (
          <button
            type="button"
            className="btn secondary"
            onClick={() => onSubmit(bounty.id, workUri)}
          >
            Submit work
          </button>
        )}
        {(bounty.status === 'claimed' || bounty.status === 'submitted') &&
          onApprove &&
          (acceptKind === 'manual' ||
            bounty.lastVerification?.passed === false) && (
            <button type="button" className="btn secondary" onClick={() => onApprove(bounty.id)}>
              {acceptKind === 'manual' ? 'Approve pay' : 'Approve pay anyway'}
            </button>
          )}
        {(bounty.status === 'claimed' || bounty.status === 'submitted') && onDispute && (
          <button type="button" className="btn secondary" onClick={() => onDispute(bounty.id)}>
            Dispute
          </button>
        )}
      </div>
    </article>
  )
}
