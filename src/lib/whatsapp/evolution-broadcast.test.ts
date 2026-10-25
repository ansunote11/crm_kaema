import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  getConnectionState: vi.fn(),
}))

vi.mock('@/lib/whatsapp/provider', () => ({
  configProvider: (c: { provider?: string } | null) => (c?.provider === 'evolution' ? 'evolution' : 'meta'),
  evolutionCredsFromConfig: () => ({ serverUrl: 'https://evo', instance: 'i', apiKey: 'k' }),
  resolveSendProvider: () => ({ sendText: h.sendText, sendMedia: h.sendMedia }),
}))
vi.mock('@/lib/whatsapp/evolution-api', () => ({ getConnectionState: h.getConnectionState }))

import { runDueBroadcasts, tickBroadcast } from './evolution-broadcast'

type Row = Record<string, unknown>
interface Op {
  table: string
  op: 'select' | 'update'
  payload?: Row
  filters: [string, ...unknown[]][]
}

/** Scripted fake: `respond` answers every query, `ops` records them all. */
function fakeDb(respond: (op: Op) => unknown) {
  const ops: Op[] = []
  const make = (table: string) => {
    const op: Op = { table, op: 'select', filters: [] }
    const chain: Record<string, unknown> = {}
    const run = () => {
      ops.push({ ...op })
      return Promise.resolve({ data: respond(op), error: null })
    }
    for (const m of ['eq', 'in', 'gte', 'or', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => {
        op.filters.push([m, ...a])
        return chain
      }
    }
    chain.select = () => chain
    chain.update = (payload: Row) => {
      op.op = 'update'
      op.payload = payload
      return chain
    }
    chain.maybeSingle = run
    chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      run().then(resolve, reject)
    return chain
  }
  return { db: { from: make } as never, ops }
}

const NOW = Date.parse('2026-10-25T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const baseBroadcast = {
  id: 'b1',
  account_id: 'acc',
  status: 'sending',
  channel: 'evolution_text',
  message_text: 'Olá {{nome}}!',
  message_link: 'https://x.com',
  message_image_url: null as string | null,
  pacing: { min_delay_seconds: 10, max_delay_seconds: 20, per_minute: 3, per_hour: 100, max_consecutive_failures: 3 },
  next_send_at: null as string | null,
  consecutive_failures: 0,
}

interface Scenario {
  broadcast?: Partial<typeof baseBroadcast> | null
  claimed?: boolean
  recentSends?: number[]
  recipient?: Row | null
  contact?: Row | null
  config?: Row | null
}

function scenario(s: Scenario = {}) {
  const broadcast = s.broadcast === null ? null : { ...baseBroadcast, ...s.broadcast }
  return fakeDb((op) => {
    if (op.table === 'broadcasts' && op.op === 'select') {
      // The rate-limit query selects only `id` of the account's campaigns.
      return op.filters.some((f) => f[0] === 'eq' && f[1] === 'channel') ? [{ id: 'b1' }] : broadcast
    }
    if (op.table === 'broadcasts' && op.op === 'update' && op.payload && 'delivery_locked_at' in op.payload) {
      return op.payload.delivery_locked_at === null ? null : s.claimed === false ? [] : [{ id: 'b1' }]
    }
    if (op.table === 'broadcast_recipients' && op.op === 'select') {
      if (op.filters.some((f) => f[0] === 'gte')) {
        return (s.recentSends ?? []).map((t) => ({ sent_at: iso(t) }))
      }
      return s.recipient === undefined ? { id: 'r1', contact_id: 'c1' } : s.recipient
    }
    if (op.table === 'contacts') {
      return s.contact === undefined ? { name: 'Maria Silva', phone: '+55 98 98161-6144' } : s.contact
    }
    if (op.table === 'whatsapp_config') {
      return s.config === undefined ? { provider: 'evolution' } : s.config
    }
    return null
  })
}

const updates = (ops: Op[], table: string) =>
  ops.filter((o) => o.table === table && o.op === 'update').map((o) => o.payload as Row)

beforeEach(() => {
  vi.clearAllMocks()
  h.sendText.mockResolvedValue({ messageId: 'WA1' })
  h.sendMedia.mockResolvedValue({ messageId: 'WA2' })
  h.getConnectionState.mockResolvedValue('open')
})

describe('tickBroadcast — guards', () => {
  it('ignores campaigns that are not running Evolution campaigns', async () => {
    expect((await tickBroadcast(scenario({ broadcast: null }).db, 'b1', NOW)).state).toBe('inactive')
    expect(
      (await tickBroadcast(scenario({ broadcast: { channel: 'template' } as never }).db, 'b1', NOW)).state,
    ).toBe('inactive')
    expect(
      (await tickBroadcast(scenario({ broadcast: { status: 'paused' } }).db, 'b1', NOW)).state,
    ).toBe('paused')
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('does nothing when another driver holds the lock', async () => {
    const { db } = scenario({ claimed: false })
    expect((await tickBroadcast(db, 'b1', NOW)).state).toBe('busy')
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('waits for next_send_at and releases the lock', async () => {
    const { db, ops } = scenario({ broadcast: { next_send_at: iso(NOW + 7_000) } })
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r).toMatchObject({ state: 'waiting', nextInMs: 7_000 })
    expect(h.sendText).not.toHaveBeenCalled()
    expect(updates(ops, 'broadcasts').at(-1)).toEqual({ delivery_locked_at: null })
  })
})

describe('tickBroadcast — rate limits', () => {
  it('holds back when the per-minute cap is reached and schedules the retry', async () => {
    const recent = [NOW - 5_000, NOW - 20_000, NOW - 40_000] // cap is 3
    const { db, ops } = scenario({ recentSends: recent })
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r).toMatchObject({ state: 'waiting', nextInMs: 20_000 })
    expect(h.sendText).not.toHaveBeenCalled()
    expect(updates(ops, 'broadcasts')).toContainEqual({ next_send_at: iso(NOW + 20_000) })
  })

  it('sends when under the cap', async () => {
    const { db } = scenario({ recentSends: [NOW - 5_000] })
    expect((await tickBroadcast(db, 'b1', NOW, () => 0)).state).toBe('sent')
  })
})

describe('tickBroadcast — sending', () => {
  it('sends the personalised text + link, records the id and schedules the next send', async () => {
    const { db, ops } = scenario()
    const r = await tickBroadcast(db, 'b1', NOW, () => 0)
    expect(r).toMatchObject({ state: 'sent', nextInMs: 10_000 }) // rng 0 -> minimum delay
    expect(h.sendText).toHaveBeenCalledWith({
      to: '5598981616144',
      text: 'Olá Maria!\n\nhttps://x.com',
    })
    expect(updates(ops, 'broadcast_recipients')[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'WA1',
    })
    expect(updates(ops, 'broadcasts')).toContainEqual({
      consecutive_failures: 0,
      next_send_at: iso(NOW + 10_000),
    })
  })

  it('sends an image with the text as its caption', async () => {
    const { db } = scenario({ broadcast: { message_image_url: 'https://x.com/a.png' } })
    await tickBroadcast(db, 'b1', NOW, () => 0)
    expect(h.sendMedia).toHaveBeenCalledWith({
      to: '5598981616144',
      kind: 'image',
      link: 'https://x.com/a.png',
      caption: 'Olá Maria!\n\nhttps://x.com',
    })
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('marks the campaign done when nothing is pending', async () => {
    const { db, ops } = scenario({ recipient: null })
    expect((await tickBroadcast(db, 'b1', NOW)).state).toBe('done')
    expect(updates(ops, 'broadcasts')).toContainEqual({ status: 'sent', next_send_at: null })
  })

  it('fails a recipient with no phone without counting toward the auto-pause', async () => {
    const { db, ops } = scenario({ contact: { name: 'X', phone: '' } })
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r).toMatchObject({ state: 'failed', reason: 'no_phone' })
    expect(h.sendText).not.toHaveBeenCalled()
    expect(updates(ops, 'broadcast_recipients')[0]).toMatchObject({ status: 'failed' })
    expect(updates(ops, 'broadcasts').some((u) => 'consecutive_failures' in u)).toBe(false)
  })
})

describe('tickBroadcast — failures and auto-pause', () => {
  it('counts a failure, keeps going and schedules the next attempt', async () => {
    h.sendText.mockRejectedValue(new Error('boom'))
    const { db, ops } = scenario({ broadcast: { consecutive_failures: 1 } })
    const r = await tickBroadcast(db, 'b1', NOW, () => 0)
    expect(r).toMatchObject({ state: 'failed', reason: 'boom', nextInMs: 10_000 })
    expect(updates(ops, 'broadcast_recipients')[0]).toMatchObject({ status: 'failed', error_message: 'boom' })
    expect(updates(ops, 'broadcasts')).toContainEqual({
      consecutive_failures: 2,
      next_send_at: iso(NOW + 10_000),
    })
  })

  it('pauses itself at the failure threshold', async () => {
    h.sendText.mockRejectedValue(new Error('boom'))
    const { db, ops } = scenario({ broadcast: { consecutive_failures: 2 } }) // threshold 3
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r.state).toBe('paused')
    expect(r.reason).toContain('3 failures in a row')
    expect(updates(ops, 'broadcasts')).toContainEqual({
      status: 'paused',
      pause_reason: expect.stringContaining('3 failures in a row'),
      consecutive_failures: 3,
    })
  })

  it('pauses at the FIRST failure when the instance is down', async () => {
    h.sendText.mockRejectedValue(new Error('timeout'))
    h.getConnectionState.mockResolvedValue('close')
    const { db, ops } = scenario()
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r.state).toBe('paused')
    expect(r.reason).toContain('not connected')
    expect(updates(ops, 'broadcasts')).toContainEqual(
      expect.objectContaining({ status: 'paused', consecutive_failures: 1 }),
    )
  })

  it('treats an unreachable instance as down rather than hammering it', async () => {
    h.sendText.mockRejectedValue(new Error('ECONNREFUSED'))
    h.getConnectionState.mockRejectedValue(new Error('ECONNREFUSED'))
    expect((await tickBroadcast(scenario().db, 'b1', NOW)).state).toBe('paused')
  })

  it('pauses when the account switched away from Evolution', async () => {
    const { db } = scenario({ config: { provider: 'meta' } })
    const r = await tickBroadcast(db, 'b1', NOW)
    expect(r.state).toBe('paused')
    expect(h.sendText).not.toHaveBeenCalled()
  })
})

describe('runDueBroadcasts', () => {
  it('reports how many campaigns it looked at and stops on a non-sending state', async () => {
    const { db } = fakeDb((op) => {
      if (op.table === 'broadcasts' && op.op === 'select') {
        return op.filters.some((f) => f[0] === 'eq' && f[1] === 'status') && !op.filters.some((f) => f[1] === 'id')
          ? [{ id: 'b1' }, { id: 'b2' }]
          : null // each tick then sees "inactive"
      }
      return null
    })
    expect(await runDueBroadcasts(db, 1_000)).toEqual({ sent: 0, campaigns: 2 })
  })
})
