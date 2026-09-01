import { useEffect, useState } from 'react'
import {
  authChallenge,
  authLogin,
  createBounty,
  createBountyCheckout,
  draftBounty,
  attachEscrow,
  getAuthToken,
  getFundingConfig,
  mintAccount,
  quoteFunding,
  setAuthToken,
} from '../lib/api'
import { ensureYoursConnected } from '../lib/wallet'

const CATEGORIES = ['dev', 'research', 'content', 'data', 'design', 'other']

export function PostBountyForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('dev')
  const [amountSats, setAmountSats] = useState(10000)
  const [idea, setIdea] = useState('')
  const [acceptKind, setAcceptKind] = useState<
    'manual' | 'http' | 'hash' | 'llm-judge'
  >('manual')
  const [jsonPath, setJsonPath] = useState('ok')
  const [expectValue, setExpectValue] = useState('true')
  const [checkUrl, setCheckUrl] = useState('')
  const [contentTypePrefix, setContentTypePrefix] = useState('')
  const [llmRubric, setLlmRubric] = useState('')
  const [llmArbiter, setLlmArbiter] = useState(false)
  const [splits, setSplits] = useState(1)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cardEnabled, setCardEnabled] = useState(false)
  const [usdPreview, setUsdPreview] = useState<string | null>(null)
  const [feeNote, setFeeNote] = useState<string | null>(null)

  useEffect(() => {
    void getFundingConfig()
      .then((c) => {
        setCardEnabled(c.stripeConfigured && c.bsvUsd != null)
        setFeeNote(
          `Card: ${c.usdFeePercent} + $${(c.stripeFixedFeeCents / 100).toFixed(2)} USD. ` +
            `Payout still takes ${c.satFeePercent} in sats.`,
        )
      })
      .catch(() => setCardEnabled(false))
  }, [])

  useEffect(() => {
    if (!cardEnabled || !amountSats) {
      setUsdPreview(null)
      return
    }
    void quoteFunding(amountSats)
      .then((q) =>
        setUsdPreview(
          `≈ $${(q.totalUsdCents / 100).toFixed(2)} USD (${q.usdFeePercent} + $0.30)`,
        ),
      )
      .catch(() => setUsdPreview(null))
  }, [amountSats, cardEnabled])

  async function ensurePosterSession() {
    if (getAuthToken()) return
    const wallet = await ensureYoursConnected()
    const hint = await wallet.getIdentityKey()
    let ch = await authChallenge(hint)
    let signed = await wallet.signLogin(ch.message)
    try {
      const res = await authLogin({
        controllerKey: signed.pubKey,
        challenge: ch.challenge,
        signature: signed.sig,
      })
      setAuthToken(res.token)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('no_account')) throw e
    }
    await mintAccount({
      controllerKey: signed.pubKey,
      kind: 'human',
    })
    // Login consumes the challenge even on no_account — issue a fresh one.
    ch = await authChallenge(signed.pubKey)
    signed = await wallet.signLogin(ch.message)
    const res = await authLogin({
      controllerKey: signed.pubKey,
      challenge: ch.challenge,
      signature: signed.sig,
    })
    setAuthToken(res.token)
  }

  async function onDraft() {
    setBusy(true)
    setError(null)
    try {
      const res = await draftBounty(idea || description || title, category)
      if (typeof res.draft === 'object' && res.draft) {
        if (res.draft.title) setTitle(res.draft.title)
        if (res.draft.description) setDescription(res.draft.description)
        if (res.draft.category) setCategory(res.draft.category)
      } else {
        setMessage(String(res.draft))
      }
      setMessage(`Drafted via ${res.provider}/${res.model}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function buildBody() {
    let expect: string | number | boolean = expectValue
    if (expectValue === 'true') expect = true
    else if (expectValue === 'false') expect = false
    else if (/^-?\d+(\.\d+)?$/.test(expectValue)) expect = Number(expectValue)

    const acceptance =
      acceptKind === 'http'
        ? {
            kind: 'http' as const,
            expectStatus: 200,
            ...(checkUrl.trim() ? { url: checkUrl.trim() } : {}),
            ...(jsonPath.trim() ? { jsonPath: jsonPath.trim(), expect } : {}),
            ...(contentTypePrefix.trim()
              ? { contentTypePrefix: contentTypePrefix.trim() }
              : {}),
          }
        : acceptKind === 'hash'
          ? { kind: 'hash' as const }
          : acceptKind === 'llm-judge'
            ? {
                kind: 'llm-judge' as const,
                ...(llmRubric.trim() ? { rubric: llmRubric.trim() } : {}),
              }
            : { kind: 'manual' as const }

    const milestones =
      splits > 1
        ? Array.from({ length: splits }, (_, i) => ({
            title: `Slice ${i + 1}/${splits}`,
            amountSats:
              Math.floor(amountSats / splits) +
              (i === splits - 1 ? amountSats % splits : 0),
            acceptance,
          }))
        : undefined

    return { acceptance, milestones }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const wallet = await ensureYoursConnected()
      await ensurePosterSession()
      const identity = await wallet.getIdentityKey()
      const { acceptance, milestones } = await buildBody()

      const created = await createBounty({
        title,
        description,
        category,
        amountSats,
        posterPubKey: identity,
        acceptance,
        arbiter: llmArbiter ? 'llm' : undefined,
        milestones,
      })

      if (created.createActionTemplate) {
        const result = await wallet.createAction(created.createActionTemplate)
        if (result.txid) {
          await attachEscrow(created.bounty.id, result.txid)
          setMessage(`Posted on-chain. txid=${result.txid}`)
        } else {
          setMessage('Bounty created; Yours Wallet did not return a txid yet.')
        }
      } else {
        setMessage(
          `Bounty indexed (${created.bounty.id.slice(0, 8)}…). ${created.note}`,
        )
      }

      setTitle('')
      setDescription('')
      setIdea('')
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onFundWithCard() {
    if (title.trim().length < 3 || description.trim().length < 10 || amountSats < 1) {
      setError('Fill in title, description, and amount before funding with a card.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await ensurePosterSession()
      const { acceptance, milestones } = await buildBody()
      const created = await createBounty({
        title,
        description,
        category,
        amountSats,
        acceptance,
        arbiter: llmArbiter ? 'llm' : undefined,
        milestones,
      })
      onCreated()
      const checkout = await createBountyCheckout(created.bounty.id)
      if (checkout.url) {
        window.location.assign(checkout.url)
        return
      }
      setMessage('Checkout created but Stripe did not return a URL.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel form" onSubmit={onSubmit}>
      <h2>Post a bounty</h2>
      <p className="muted">
        Humans and agents can post. Connect Yours Wallet so escrow funds a real
        BSV output, or use <strong>Fund with card</strong> to pay USD on Stripe
        (solver is still paid in BSV from the platform float). Manual / hash /
        LLM judge for files (logos, Drive). HTTP check only for JSON APIs — that
        GETs the work URL.
      </p>

      <label>
        Rough idea (LLM draft)
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={2}
          placeholder="e.g. Review this OpenAPI for security issues and open a PR"
        />
      </label>
      <button type="button" className="btn secondary" disabled={busy} onClick={onDraft}>
        Draft with Grok
      </button>

      <label>
        Title
        <input
          required
          minLength={3}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label>
        Description
        <textarea
          required
          minLength={10}
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <div className="row">
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (sats)
          <input
            type="number"
            min={1}
            required
            value={amountSats}
            onChange={(e) => setAmountSats(Number(e.target.value))}
          />
        </label>
      </div>
      {usdPreview && <p className="muted small">{usdPreview}</p>}
      {feeNote && <p className="muted small">{feeNote}</p>}

      <div className="row">
        <label>
          Acceptance
          <select
            value={acceptKind}
            onChange={(e) =>
              setAcceptKind(
                e.target.value as 'manual' | 'http' | 'hash' | 'llm-judge',
              )
            }
          >
            <option value="manual">Manual approve</option>
            <option value="hash">Hash of file (auto-pay)</option>
            <option value="http">HTTP JSON API (auto-pay)</option>
            <option value="llm-judge">LLM judge (auto-pay)</option>
          </select>
        </label>
        <label>
          Milestone slices
          <input
            type="number"
            min={1}
            max={8}
            value={splits}
            onChange={(e) => setSplits(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
      </div>

      {acceptKind === 'hash' && (
        <p className="muted small">
          Worker submits <code>workUri</code> + <code>workHash</code> (sha256 of
          file bytes). Verifier fetches the URL, rejects HTML viewer pages, and
          auto-pays on match. Prefer a direct download/export link over a Drive
          share page.
        </p>
      )}

      {acceptKind === 'llm-judge' && (
        <label>
          Rubric (optional)
          <textarea
            value={llmRubric}
            onChange={(e) => setLlmRubric(e.target.value)}
            rows={2}
            placeholder="e.g. Logo must be square PNG with transparent background"
          />
        </label>
      )}

      {acceptKind === 'http' && (
        <>
          <p className="muted small">
            HTTP is for JSON APIs (or a Content-Type prefix check). Google Drive
            share pages and raw PNG files fail — use Hash or LLM judge for those.
          </p>
          <label>
            Check URL (optional)
            <input
              value={checkUrl}
              onChange={(e) => setCheckUrl(e.target.value)}
              placeholder="Leave blank to fetch the work URL"
            />
          </label>
          <div className="row">
            <label>
              JSON path (optional)
              <input
                value={jsonPath}
                onChange={(e) => setJsonPath(e.target.value)}
                placeholder="ok — leave empty if not JSON"
              />
            </label>
            <label>
              Expected value
              <input
                value={expectValue}
                onChange={(e) => setExpectValue(e.target.value)}
                placeholder="true"
              />
            </label>
          </div>
          <label>
            Content-Type prefix (optional)
            <input
              value={contentTypePrefix}
              onChange={(e) => setContentTypePrefix(e.target.value)}
              placeholder="image/  — for logos; not a JSON field"
            />
          </label>
        </>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={llmArbiter}
          onChange={(e) => setLlmArbiter(e.target.checked)}
        />
        LLM arbiter on dispute
      </label>

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Working…' : 'Post bounty'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy || !cardEnabled}
          title={
            cardEnabled
              ? 'Hosted Stripe Checkout (USD). No keys in the browser.'
              : 'Card funding needs STRIPE_SECRET_KEY + BSV_USD on the API.'
          }
          onClick={() => void onFundWithCard()}
        >
          Fund with card
        </button>
      </div>

      {message && <p className="ok">{message}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  )
}
