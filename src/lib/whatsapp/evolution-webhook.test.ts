import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  processNormalizedInbound: vi.fn(),
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
  applyMessageStatus: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  existingMessage: null as { id: string } | null,
  upsertResult: [{ id: 'm1' }] as { id: string }[],
  ops: [] as { table: string; op: string; row?: unknown; filters?: unknown[] }[],
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/whatsapp/inbound-pipeline', () => ({
  processNormalizedInbound: h.processNormalizedInbound,
  findOrCreateContact: h.findOrCreateContact,
  findOrCreateConversation: h.findOrCreateConversation,
}))
vi.mock('@/lib/whatsapp/message-status-sync', () => ({
  applyMessageStatus: h.applyMessageStatus,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))

import { handleEvolutionEvent, hashWebhookToken, secretMatches } from './evolution-webhook'

/** Chainable fake that records every write and resolves canned reads. */
function fakeDb() {
  const make = (table: string) => {
    const state = { op: 'select', row: undefined as unknown, filters: [] as unknown[] }
    const chain: Record<string, unknown> = {}
    const done = () => {
      h.ops.push({ table, op: state.op, row: state.row, filters: state.filters })
    }
    for (const m of ['eq', 'neq', 'is']) {
      chain[m] = (...a: unknown[]) => {
        state.filters.push([m, ...a])
        return chain
      }
    }
    chain.select = () => chain
    chain.update = (row: unknown) => {
      state.op = 'update'
      state.row = row
      return chain
    }
    chain.upsert = (row: unknown) => {
      state.op = 'upsert'
      state.row = row
      return chain
    }
    chain.maybeSingle = async () => {
      done()
      return { data: table === 'messages' ? h.existingMessage : null, error: null }
    }
    chain.then = (resolve: (v: unknown) => void) => {
      done()
      resolve({
        data: state.op === 'upsert' ? h.upsertResult : null,
        error: null,
      })
    }
    return chain
  }
  return { from: (t: string) => make(t) } as never
}

const config = {
  id: 'cfg1',
  account_id: 'acc1',
  user_id: 'u1',
  status: 'disconnected',
  evolution_server_url: 'https://evo',
  evolution_instance: 'i1',
  evolution_api_key: 'KEY',
}

const upsertEvent = (data: Record<string, unknown>) => ({ event: 'MESSAGES_UPSERT', data })

beforeEach(() => {
  vi.clearAllMocks()
  h.ops.length = 0
  h.existingMessage = null
  h.upsertResult = [{ id: 'm1' }]
  h.findOrCreateContact.mockResolvedValue({ contact: { id: 'c1' }, wasCreated: false })
  h.findOrCreateConversation.mockResolvedValue({ conversation: { id: 'conv1' }, created: false })
  h.applyMessageStatus.mockResolvedValue([])
})

describe('customer messages', () => {
  it('normalizes and hands off to the shared pipeline', async () => {
    await handleEvolutionEvent(
      config,
      upsertEvent({
        key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: false, id: 'WA1' },
        pushName: 'Maria',
        messageTimestamp: 1700000000,
        message: { conversation: 'oi' },
      }),
      fakeDb(),
    )
    expect(h.processNormalizedInbound).toHaveBeenCalledTimes(1)
    const arg = h.processNormalizedInbound.mock.calls[0][0]
    expect(arg).toMatchObject({ accountId: 'acc1', configOwnerUserId: 'u1' })
    expect(arg.inbound).toMatchObject({
      externalMessageId: 'WA1',
      type: 'text',
      timestamp: '2023-11-14T22:13:20.000Z',
      identity: { phone: '5511999990000', name: 'Maria' },
      textBody: 'oi',
    })
    expect(arg.inbound.content).toMatchObject({ contentText: 'oi' })
  })

  it('ignores group chats', async () => {
    await handleEvolutionEvent(
      config,
      upsertEvent({ key: { remoteJid: '123@g.us', fromMe: false, id: 'G1' }, message: { conversation: 'x' } }),
      fakeDb(),
    )
    expect(h.processNormalizedInbound).not.toHaveBeenCalled()
  })
})

describe('fromMe echoes', () => {
  const echo = (id = 'ECHO1') =>
    upsertEvent({
      key: { remoteJid: '5511999990000@s.whatsapp.net', fromMe: true, id },
      pushName: 'Operator Name',
      messageTimestamp: 1700000000,
      message: { conversation: 'sent from phone' },
    })

  it('dedupes by key.id: an already-stored message is a no-op', async () => {
    h.existingMessage = { id: 'already' }
    await handleEvolutionEvent(config, echo(), fakeDb())
    expect(h.ops.some((o) => o.table === 'messages' && o.op === 'upsert')).toBe(false)
    expect(h.processNormalizedInbound).not.toHaveBeenCalled()
  })

  it('persists as agent, never fans out, never touches unread, pauses flows', async () => {
    await handleEvolutionEvent(config, echo(), fakeDb())

    // No fan-out through the shared pipeline.
    expect(h.processNormalizedInbound).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()

    // Inserted as an agent message.
    const insert = h.ops.find((o) => o.table === 'messages' && o.op === 'upsert')
    expect(insert?.row).toMatchObject({
      sender_type: 'agent',
      message_id: 'ECHO1',
      status: 'sent',
      content_text: 'sent from phone',
    })

    // Conversation preview refreshed WITHOUT an unread bump.
    const convUpdate = h.ops.find((o) => o.table === 'conversations' && o.op === 'update')
    expect(convUpdate?.row).toMatchObject({ last_message_text: 'sent from phone' })
    expect(JSON.stringify(convUpdate?.row)).not.toContain('unread')

    // Active flow runs are paused for the human.
    const pause = h.ops.find((o) => o.table === 'flow_runs' && o.op === 'update')
    expect(pause?.row).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' })
  })

  it("never uses the echo's pushName as the contact name", async () => {
    await handleEvolutionEvent(config, echo(), fakeDb())
    const identity = h.findOrCreateContact.mock.calls[0][2]
    expect(identity.name).toBe('')
    expect(identity.phone).toBe('5511999990000')
  })

  it('ignores fromMe reactions in v1', async () => {
    await handleEvolutionEvent(
      config,
      upsertEvent({
        key: { remoteJid: '5511@s.whatsapp.net', fromMe: true, id: 'R1' },
        message: { reactionMessage: { key: { id: 'T' }, text: '👍' } },
      }),
      fakeDb(),
    )
    expect(h.findOrCreateContact).not.toHaveBeenCalled()
    expect(h.processNormalizedInbound).not.toHaveBeenCalled()
  })
})

describe('other events', () => {
  it('connection.update writes only when the status changed', async () => {
    await handleEvolutionEvent(config, { event: 'CONNECTION_UPDATE', data: { state: 'close' } }, fakeDb())
    expect(h.ops).toHaveLength(0) // already disconnected

    await handleEvolutionEvent(config, { event: 'connection.update', data: { state: 'open' } }, fakeDb())
    const write = h.ops.find((o) => o.table === 'whatsapp_config' && o.op === 'update')
    expect(write?.row).toMatchObject({ status: 'connected' })
  })

  it('messages.update advances statuses and emits the public event', async () => {
    h.applyMessageStatus.mockResolvedValue([{ id: 'm1', conversation_id: 'conv1' }])
    await handleEvolutionEvent(
      config,
      { event: 'MESSAGES_UPDATE', data: { keyId: 'WA9', status: 'READ' } },
      fakeDb(),
    )
    expect(h.applyMessageStatus.mock.calls[0][1]).toBe('acc1')
    expect(h.applyMessageStatus.mock.calls[0][2]).toMatchObject({ wamid: 'WA9', status: 'read' })
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc1',
      'message.status_updated',
      { whatsapp_message_id: 'WA9', conversation_id: 'conv1', status: 'read' },
    )
  })

  it('ignores qrcode.updated and unknown events', async () => {
    await handleEvolutionEvent(config, { event: 'QRCODE_UPDATED', data: {} }, fakeDb())
    expect(h.ops).toHaveLength(0)
  })
})

describe('token helpers', () => {
  it('hashes with sha256 hex and compares in constant time', () => {
    expect(hashWebhookToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(secretMatches('tok', 'tok')).toBe(true)
    expect(secretMatches('tok', 'tok2')).toBe(false)
    expect(secretMatches('', 'tok')).toBe(false)
  })
})
