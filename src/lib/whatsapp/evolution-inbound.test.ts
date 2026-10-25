import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearJidCache,
  connectionStateToStatus,
  evolutionContent,
  evolutionIdentity,
  evolutionTimestampToIso,
  extractStatusUpdates,
  jidToPhone,
  normalizeEventName,
  parseEvolutionMessage,
  resolvePeer,
} from './evolution-inbound'

const creds = { serverUrl: 'https://evo', instance: 'i1' }

describe('normalizeEventName', () => {
  it('lowercases and swaps underscores for dots', () => {
    expect(normalizeEventName('MESSAGES_UPSERT')).toBe('messages.upsert')
    expect(normalizeEventName('connection.update')).toBe('connection.update')
    expect(normalizeEventName(undefined)).toBe('')
  })
})

describe('parseEvolutionMessage', () => {
  it('parses plain and extended text with a reply stanza', () => {
    expect(parseEvolutionMessage({ message: { conversation: 'oi' } })).toMatchObject({
      type: 'text', text: 'oi',
    })
    const r = parseEvolutionMessage({
      message: { extendedTextMessage: { text: 'q', contextInfo: { stanzaId: 'P1' } } },
    })
    expect(r).toMatchObject({ type: 'text', text: 'q', replyToId: 'P1' })
  })

  it('falls back to data.contextInfo (CTWA card at the record root)', () => {
    const r = parseEvolutionMessage({
      message: { conversation: 'from ad' },
      contextInfo: { stanzaId: 'AD1' },
    })
    expect(r.replyToId).toBe('AD1')
  })

  it('parses media with caption/mimetype and unwraps ephemeral messages', () => {
    const r = parseEvolutionMessage({
      message: {
        ephemeralMessage: {
          message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } },
        },
      },
    })
    expect(r).toMatchObject({ type: 'image', caption: 'look', mimetype: 'image/jpeg', hasMedia: true })
    expect(
      parseEvolutionMessage({
        message: { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf' } },
      }),
    ).toMatchObject({ type: 'document', fileName: 'a.pdf' })
  })

  it('parses reactions, button and list replies', () => {
    expect(
      parseEvolutionMessage({ message: { reactionMessage: { key: { id: 'T' }, text: '👍' } } }).reaction,
    ).toEqual({ targetMessageId: 'T', emoji: '👍' })
    expect(
      parseEvolutionMessage({
        message: { buttonsResponseMessage: { selectedButtonId: 'b1', selectedDisplayText: 'Yes' } },
      }),
    ).toMatchObject({ type: 'interactive', interactiveReplyId: 'b1', text: 'Yes' })
    expect(
      parseEvolutionMessage({
        message: { listResponseMessage: { title: 'Row', singleSelectReply: { selectedRowId: 'r9' } } },
      }),
    ).toMatchObject({ type: 'interactive', interactiveReplyId: 'r9' })
  })

  it('marks unknown shapes as unknown', () => {
    expect(parseEvolutionMessage({ message: { pollCreationMessage: {} } }).type).toBe('unknown')
  })
})

describe('evolutionContent', () => {
  it('points media at the proxy route and keeps the caption', () => {
    const c = evolutionContent(
      parseEvolutionMessage({ message: { imageMessage: { caption: 'c', mimetype: 'image/png' } } }),
      'ID 1',
    )
    expect(c).toMatchObject({
      contentText: 'c',
      mediaUrl: '/api/whatsapp/evolution/media/ID%201',
      mediaType: 'image/png',
    })
  })
})

describe('timestamps', () => {
  it('handles number, numeric string, Long and garbage', () => {
    expect(evolutionTimestampToIso(1700000000)).toBe('2023-11-14T22:13:20.000Z')
    expect(evolutionTimestampToIso('1700000000')).toBe('2023-11-14T22:13:20.000Z')
    expect(evolutionTimestampToIso({ low: 1700000000 })).toBe('2023-11-14T22:13:20.000Z')
    expect(evolutionTimestampToIso(undefined, 0)).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('resolvePeer (LID)', () => {
  beforeEach(() => clearJidCache())

  it('uses the phone JID directly without calling the lookup', async () => {
    const lookup = vi.fn()
    const peer = await resolvePeer({ remoteJid: '5511999990000@s.whatsapp.net', id: 'M' }, creds, lookup)
    expect(peer).toEqual({ phone: '5511999990000', lidJid: null })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('recovers the phone from the store when only the LID arrives, and caches it', async () => {
    const lookup = vi.fn().mockResolvedValue({
      phoneJid: '5511999990000@s.whatsapp.net',
      lidJid: '999@lid',
    })
    const a = await resolvePeer({ remoteJid: '999@lid', id: 'M1' }, creds, lookup)
    const b = await resolvePeer({ remoteJid: '999@lid', id: 'M2' }, creds, lookup)
    expect(a).toEqual({ phone: '5511999990000', lidJid: '999@lid' })
    expect(b).toEqual(a)
    expect(lookup).toHaveBeenCalledTimes(1) // cached per jid, not per messageId
  })

  it('keys the cache by server+instance', async () => {
    const lookup = vi.fn().mockResolvedValue({ phoneJid: null, lidJid: null })
    await resolvePeer({ remoteJid: '1@lid', id: 'A' }, creds, lookup)
    await resolvePeer({ remoteJid: '1@lid', id: 'A' }, { ...creds, instance: 'i2' }, lookup)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('never throws: a failing lookup degrades to LID-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lookup = vi.fn().mockRejectedValue(new Error('boom'))
    const peer = await resolvePeer({ remoteJid: '7@lid', id: 'M' }, creds, lookup)
    expect(peer).toEqual({ phone: '', lidJid: '7@lid' })
    warn.mockRestore()
  })

  it('returns null when there is no usable JID at all', async () => {
    expect(await resolvePeer({}, creds, vi.fn())).toBeNull()
  })

  it('uses remoteJidAlt when remoteJid is the LID', async () => {
    const peer = await resolvePeer(
      { remoteJid: '5@lid', remoteJidAlt: '5511888880000@s.whatsapp.net', id: 'M' },
      creds,
      vi.fn(),
    )
    expect(peer?.phone).toBe('5511888880000')
  })
})

describe('evolutionIdentity', () => {
  it('never takes pushName from a fromMe echo (it is the operator)', () => {
    const peer = { phone: '5511', lidJid: null }
    expect(evolutionIdentity(peer, 'Operator', true).name).toBe('')
    expect(evolutionIdentity(peer, 'Customer', false).name).toBe('Customer')
  })

  it('stores a phone-less LID in the BSUID column', () => {
    expect(evolutionIdentity({ phone: '', lidJid: '9@lid' }, undefined, false)).toMatchObject({
      phone: '', waUserId: '9@lid',
    })
    expect(evolutionIdentity({ phone: '5511', lidJid: '9@lid' }, undefined, false).waUserId).toBeNull()
  })
})

describe('status + connection', () => {
  it('maps Baileys statuses, accepts single or array, drops unknown', () => {
    expect(
      extractStatusUpdates([
        { keyId: 'A', status: 'DELIVERY_ACK' },
        { key: { id: 'B' }, status: 'READ' },
        { messageId: 'C', status: 'ERROR' },
        { keyId: 'D', status: 'WHATEVER' },
      ]),
    ).toEqual([
      { messageId: 'A', status: 'delivered' },
      { messageId: 'B', status: 'read' },
      { messageId: 'C', status: 'failed' },
    ])
    expect(extractStatusUpdates({ keyId: 'X', status: 'SERVER_ACK' })).toEqual([
      { messageId: 'X', status: 'sent' },
    ])
  })

  it('maps open to connected only', () => {
    expect(connectionStateToStatus({ state: 'open' })).toBe('connected')
    expect(connectionStateToStatus({ state: 'close' })).toBe('disconnected')
    expect(connectionStateToStatus(null)).toBe('disconnected')
  })

  it('extracts digits from phone JIDs only', () => {
    expect(jidToPhone('5511@s.whatsapp.net')).toBe('5511')
    expect(jidToPhone('5511:12@s.whatsapp.net')).toBe('5511')
    expect(jidToPhone('1@lid')).toBeNull()
  })
})
