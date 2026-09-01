import { persistFrom, type JsonPersist } from './persist.js'

interface StoreFile {
  /** Checkout Session id → bounty id + time. Idempotency key for webhooks. */
  processed: Record<string, { bountyId: string; at: string }>
}

function memoryPersist(): JsonPersist {
  let data: string | null = null
  return {
    async read() {
      return data
    },
    async write(next) {
      data = next
    },
  }
}

export class StripeEventStore {
  private backend: JsonPersist
  private processed: Record<string, { bountyId: string; at: string }> = {}

  constructor(dataDirOrPersist?: string | JsonPersist) {
    this.backend = dataDirOrPersist
      ? persistFrom(dataDirOrPersist, 'stripe-events.json')
      : memoryPersist()
  }

  async init(): Promise<void> {
    const raw = await this.backend.read()
    if (!raw) {
      this.processed = {}
      return
    }
    try {
      const parsed = JSON.parse(raw) as StoreFile
      this.processed = parsed.processed ?? {}
    } catch {
      this.processed = {}
    }
  }

  private async persist(): Promise<void> {
    await this.backend.write(
      JSON.stringify({ processed: this.processed }, null, 2),
    )
  }

  has(sessionId: string): boolean {
    return Boolean(this.processed[sessionId])
  }

  get(sessionId: string): { bountyId: string; at: string } | undefined {
    return this.processed[sessionId]
  }

  async mark(sessionId: string, bountyId: string): Promise<void> {
    if (this.processed[sessionId]) return
    this.processed[sessionId] = { bountyId, at: new Date().toISOString() }
    await this.persist()
  }
}
