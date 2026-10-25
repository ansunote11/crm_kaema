import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evolutionFetch,
  extractEvolutionError,
  findMessageJids,
  getConnectionState,
  sendAudio,
  sendMedia,
  sendReaction,
  sendText,
  setWebhook,
  toJid,
} from './evolution-api'

const creds = { serverUrl: 'https://evo.example.com/', instance: 'my inst', apiKey: 'K' }

type Call = { url: string; init: RequestInit }
let calls: Call[]
let responder: (call: Call) => { status: number; body: unknown }

beforeEach(() => {
  calls = []
  responder = () => ({ status: 200, body: { key: { id: 'BAE5' } } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init }
      calls.push(call)
      const r = responder(call)
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      }
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const bodyOf = (c: Call) => JSON.parse(c.init.body as string)

describe('evolutionFetch', () => {
  it('builds {serverUrl}{path}/{encoded instance} and sends the apikey header', async () => {
    await sendText({ ...creds, to: '+55 11 99999-0000', text: 'hi' })
    expect(calls[0].url).toBe('https://evo.example.com/message/sendText/my%20inst')
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('K')
    expect(bodyOf(calls[0])).toEqual({ number: '5511999990000', text: 'hi' })
  })

  it('throws with the API message in every known shape', async () => {
    for (const [body, expected] of [
      [{ response: { message: ['a', 'b'] } }, 'a; b'],
      [{ response: { message: 'nope' } }, 'nope'],
      [{ message: 'plain' }, 'plain'],
      [{ error: 'Unauthorized' }, 'Unauthorized'],
      [{}, 'Evolution API error: 500'],
    ] as const) {
      responder = () => ({ status: 500, body })
      await expect(evolutionFetch(creds, 'GET', '/x')).rejects.toThrow(expected)
    }
    expect(extractEvolutionError(null, 502)).toBe('Evolution API error: 502')
  })
})

describe('sends', () => {
  it('returns key.id as messageId and quotes a reply', async () => {
    const r = await sendText({ ...creds, to: '5511', text: 't', quotedMessageId: 'Q1' })
    expect(r).toEqual({ messageId: 'BAE5' })
    expect(bodyOf(calls[0]).quoted).toEqual({ key: { id: 'Q1' } })
  })

  it('fails when the API returns no key.id', async () => {
    responder = () => ({ status: 200, body: {} })
    await expect(sendText({ ...creds, to: '5511', text: 't' })).rejects.toThrow('message id')
  })

  it('sends audio through the dedicated PTT endpoint, not sendMedia', async () => {
    await sendAudio({ ...creds, to: '5511', audio: 'https://x/a.mp3' })
    expect(calls[0].url).toContain('/message/sendWhatsAppAudio/')
    await sendMedia({
      ...creds, to: '5511', mediatype: 'image', media: 'https://x/i.png', caption: 'c',
    })
    expect(calls[1].url).toContain('/message/sendMedia/')
    expect(bodyOf(calls[1])).toMatchObject({ mediatype: 'image', caption: 'c' })
  })

  it('builds a reaction key with the peer JID and supports removal', async () => {
    await sendReaction({
      ...creds, to: '+55 11 9', targetMessageId: 'M1', fromMe: false, emoji: '',
    })
    expect(bodyOf(calls[0])).toEqual({
      key: { remoteJid: toJid('5511 9'), fromMe: false, id: 'M1' },
      reaction: '',
    })
  })
})

describe('getConnectionState', () => {
  it('reads both response shapes and defaults to close', async () => {
    responder = () => ({ status: 200, body: { instance: { state: 'open' } } })
    expect(await getConnectionState(creds)).toBe('open')
    responder = () => ({ status: 200, body: { state: 'connecting' } })
    expect(await getConnectionState(creds)).toBe('connecting')
    responder = () => ({ status: 200, body: { state: 'weird' } })
    expect(await getConnectionState(creds)).toBe('close')
  })
})

describe('setWebhook', () => {
  const args = { ...creds, url: 'https://crm/h/T', events: ['MESSAGES_UPSERT'], headers: { 'x-webhook-secret': 'T' } }

  it('tries the v2 envelope first with byEvents=false', async () => {
    await setWebhook(args)
    expect(calls).toHaveLength(1)
    expect(bodyOf(calls[0])).toEqual({
      webhook: {
        enabled: true,
        url: 'https://crm/h/T',
        byEvents: false,
        base64: false,
        headers: { 'x-webhook-secret': 'T' },
        events: ['MESSAGES_UPSERT'],
      },
    })
  })

  it('retries with the flat shape on a 400', async () => {
    responder = (c) =>
      'webhook' in JSON.parse(c.init.body as string)
        ? { status: 400, body: { message: 'bad shape' } }
        : { status: 200, body: {} }
    await setWebhook(args)
    expect(calls).toHaveLength(2)
    expect(bodyOf(calls[1])).toMatchObject({
      enabled: true,
      url: 'https://crm/h/T',
      webhookByEvents: false,
      webhookBase64: false,
    })
  })

  it('does not retry on non-400 errors and can disable the hook', async () => {
    responder = () => ({ status: 401, body: { message: 'Unauthorized' } })
    await expect(setWebhook(args)).rejects.toThrow('Unauthorized')
    expect(calls).toHaveLength(1)

    responder = () => ({ status: 200, body: {} })
    await setWebhook({ ...creds, url: '', events: [], enabled: false })
    expect(bodyOf(calls[1]).webhook).toMatchObject({ enabled: false, url: '', byEvents: false })
  })
})

describe('findMessageJids', () => {
  it('classifies by suffix, never by position', async () => {
    // Inverted order: Alt holds the phone JID, remoteJid the LID.
    responder = () => ({
      status: 200,
      body: [{ key: { remoteJid: '123@lid', remoteJidAlt: '5511999990000@s.whatsapp.net' } }],
    })
    expect(await findMessageJids({ ...creds, messageId: 'M' })).toEqual({
      phoneJid: '5511999990000@s.whatsapp.net',
      lidJid: '123@lid',
    })
  })

  it('also reads the {messages:{records}} envelope', async () => {
    responder = () => ({
      status: 200,
      body: { messages: { records: [{ key: { remoteJid: '5511@s.whatsapp.net' } }] } },
    })
    expect((await findMessageJids({ ...creds, messageId: 'M' })).phoneJid).toBe('5511@s.whatsapp.net')
  })
})
