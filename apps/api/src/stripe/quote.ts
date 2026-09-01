/** 1 BSV = 100_000_000 sats. */
export const SATS_PER_BSV = 100_000_000

/** Stripe's minimum USD charge. */
export const STRIPE_USD_MIN_CENTS = 50

/** Default USD card-processing gross-up: 2.90% (Stripe US card percentage). */
export const DEFAULT_USD_FEE_BPS = 290

/** Default Stripe US card fixed fee, in cents. */
export const STRIPE_FIXED_FEE_CENTS = 30

export type CardQuote = {
  amountSats: number
  bsvUsd: number
  netUsdCents: number
  feeUsdCents: number
  totalUsdCents: number
  usdFeeBps: number
  fixedFeeCents: number
}

export function usdFeeBpsFromEnv(): number {
  const n = Number(process.env.USD_FEE_BPS ?? DEFAULT_USD_FEE_BPS)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_USD_FEE_BPS
  return Math.floor(n)
}

export function satFeeBpsFromEnv(): number {
  const n = Number(process.env.PLATFORM_FEE_BPS ?? 200)
  if (!Number.isFinite(n) || n < 0) return 200
  return Math.floor(n)
}

export function bsvUsdFromEnv(): number | null {
  const n = Number(process.env.BSV_USD)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function usdFeePercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

/**
 * Convert a sat bounty into a Stripe USD charge.
 * USD fee (bps + fixed cents) is added on top of the sats→USD conversion so
 * the platform Stripe balance can cover card processing. Solver payout still
 * uses PLATFORM_FEE_BPS in sats.
 */
export function quoteCardCharge(opts: {
  amountSats: number
  bsvUsd: number
  usdFeeBps?: number
  fixedFeeCents?: number
}): CardQuote {
  if (!Number.isFinite(opts.amountSats) || opts.amountSats <= 0) {
    throw new Error('invalid_amount_sats')
  }
  if (!Number.isFinite(opts.bsvUsd) || opts.bsvUsd <= 0) {
    throw new Error('invalid_bsv_usd')
  }
  const usdFeeBps = opts.usdFeeBps ?? usdFeeBpsFromEnv()
  const fixedFeeCents = opts.fixedFeeCents ?? STRIPE_FIXED_FEE_CENTS
  const netUsd = (opts.amountSats / SATS_PER_BSV) * opts.bsvUsd
  const netUsdCents = Math.max(1, Math.round(netUsd * 100))
  const feeUsdCents =
    Math.round((netUsdCents * usdFeeBps) / 10_000) + fixedFeeCents
  const totalUsdCents = Math.max(
    STRIPE_USD_MIN_CENTS,
    netUsdCents + feeUsdCents,
  )
  return {
    amountSats: opts.amountSats,
    bsvUsd: opts.bsvUsd,
    netUsdCents,
    feeUsdCents,
    totalUsdCents,
    usdFeeBps,
    fixedFeeCents,
  }
}
