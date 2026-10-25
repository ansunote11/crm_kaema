import { describe, it, expect, vi } from 'vitest'
import {
  registerEvolutionWebhook,
  resolvePublicOrigin,
  validateInstanceName,
  validateServerUrl,
} from './evolution-config'
import { hashWebhookToken } from './evolution-webhook'
import { configProvider, supportsBroadcasts, supportsTemplates } from './provider'

const creds = { serverUrl: 'https://evo', instance: 'i', apiKey: 'K' }

describe('validateServerUrl', () => {
  it('accepts an origin and strips the trailing slash', () => {
    expect(validateServerUrl('https://evo.example.com/')).toEqual({ ok: true, url: 'https://evo.example.com' })
    expect(validateServerUrl('http://localhost:8080')).toEqual({ ok: true, url: 'http://localhost:8080' })
  })

  it('rejects paths, queries, other schemes and junk', () => {
    for (const bad of ['https://evo/manager', 'https://evo/?a=1', 'ftp://evo', 'nope', '', undefined]) {
      expect(validateServerUrl(bad).ok).toBe(false)
    }
  })
})

describe('validateInstanceName', () => {
  it('rejects path separators', () => {
    for (const bad of ['a/b', 'a\\b', 'a?b', 'a#b', '', '   ']) {
      expect(validateInstanceName(bad).ok).toBe(false)
    }
    expect(validateInstanceName(' my-inst ')).toEqual({ ok: true, name: 'my-inst' })
  })
})

describe('resolvePublicOrigin', () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null })

  it('prefers NEXT_PUBLIC_SITE_URL', () => {
    expect(resolvePublicOrigin(h({ 'x-forwarded-host': 'p.com' }), 'http://localhost:3000/x', 'https://crm.me/')).toBe('https://crm.me')
  })

  it('then forwarded host/proto, then the request origin', () => {
    expect(resolvePublicOrigin(h({ 'x-forwarded-host': 'p.com', 'x-forwarded-proto': 'https' }), 'http://localhost:3000/x', undefined)).toBe('https://p.com')
    expect(resolvePublicOrigin(h({}), 'http://localhost:3000/api/x', undefined)).toBe('http://localhost:3000')
  })
})

describe('registerEvolutionWebhook', () => {
  it('registers a fresh token in the path and as x-webhook-secret', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    const r = await registerEvolutionWebhook(creds, 'https://crm.me', register)
    expect(r.error).toBeNull()
    expect(r.setAt).not.toBeNull()
    expect(r.webhookUrl).toBe(`https://crm.me/api/whatsapp/evolution/webhook/${r.token}`)
    expect(r.tokenHash).toBe(hashWebhookToken(r.token))
    expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(register.mock.calls[0][0]).toMatchObject({
      url: r.webhookUrl,
      events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'],
      headers: { 'x-webhook-secret': r.token },
    })
  })

  it('rotates the token on every call', async () => {
    const register = vi.fn().mockResolvedValue(undefined)
    const a = await registerEvolutionWebhook(creds, 'https://crm.me', register)
    const b = await registerEvolutionWebhook(creds, 'https://crm.me', register)
    expect(a.token).not.toBe(b.token)
  })

  it('reports a failure instead of throwing (does not block the save)', async () => {
    const register = vi.fn().mockRejectedValue(new Error('instance not found'))
    const r = await registerEvolutionWebhook(creds, 'https://crm.me', register)
    expect(r.setAt).toBeNull()
    expect(r.error).toBe('instance not found')
    expect(r.tokenHash).toBeTruthy() // the hash is still persisted for a retry
  })
})

describe('provider helpers', () => {
  it('treats anything but "evolution" as meta', () => {
    expect(configProvider({ provider: 'evolution' })).toBe('evolution')
    expect(configProvider({ provider: 'meta' })).toBe('meta')
    expect(configProvider({})).toBe('meta')
    expect(configProvider(null)).toBe('meta')
    expect(configProvider({ provider: 'garbage' })).toBe('meta')
  })

  it('gates templates and broadcasts to Meta', () => {
    expect(supportsTemplates({ provider: 'evolution' })).toBe(false)
    expect(supportsBroadcasts({ provider: 'evolution' })).toBe(false)
    expect(supportsTemplates({})).toBe(true)
    expect(supportsBroadcasts({ provider: 'meta' })).toBe(true)
  })
})
