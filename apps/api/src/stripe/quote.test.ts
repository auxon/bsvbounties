import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_USD_FEE_BPS,
  quoteCardCharge,
  STRIPE_FIXED_FEE_CENTS,
  STRIPE_USD_MIN_CENTS,
} from './quote.js'

describe('quoteCardCharge', () => {
  it('converts sats to USD cents and adds documented USD fee', () => {
    // 100_000_000 sats = 1 BSV at $50 → $50.00 net
    const q = quoteCardCharge({
      amountSats: 100_000_000,
      bsvUsd: 50,
      usdFeeBps: 290,
      fixedFeeCents: 30,
    })
    assert.equal(q.netUsdCents, 5000)
    assert.equal(q.feeUsdCents, Math.round((5000 * 290) / 10_000) + 30)
    assert.equal(q.totalUsdCents, 5000 + q.feeUsdCents)
    assert.equal(q.usdFeeBps, DEFAULT_USD_FEE_BPS)
    assert.equal(q.fixedFeeCents, STRIPE_FIXED_FEE_CENTS)
  })

  it('enforces Stripe USD minimum', () => {
    const q = quoteCardCharge({
      amountSats: 1,
      bsvUsd: 25,
      usdFeeBps: 0,
      fixedFeeCents: 0,
    })
    assert.equal(q.totalUsdCents, STRIPE_USD_MIN_CENTS)
  })
})
