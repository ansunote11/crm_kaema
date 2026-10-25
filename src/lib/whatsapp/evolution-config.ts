// ============================================================
// Evolution provider config helpers (validation + webhook registration).
// Pure / injectable so the POST /api/whatsapp/config handler stays thin
// and this logic is unit-testable without a database.
// ============================================================

import { randomBytes } from 'crypto'

import {
  EVOLUTION_WEBHOOK_EVENTS,
  normalizeServerUrl,
  setWebhook,
  type EvolutionCreds,
} from '@/lib/whatsapp/evolution-api'
import { hashWebhookToken } from '@/lib/whatsapp/evolution-webhook'

/**
 * Accept only the ORIGIN of an http(s) URL. A path/query/hash means the
 * user pasted a full endpoint (e.g. `/manager`), which would silently
 * break every request — reject with a clear message instead.
 */
export function validateServerUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'evolution_server_url is required' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'evolution_server_url must be a valid http(s) URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'evolution_server_url must be http or https' }
  }
  if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    return {
      ok: false,
      error: 'evolution_server_url must be only the server origin (no path or query)',
    }
  }
  return { ok: true, url: normalizeServerUrl(parsed.origin) }
}

/** Instance names go in a URL path segment — reject separators. */
export function validateInstanceName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'evolution_instance is required' }
  }
  const name = raw.trim()
  if (name.length > 100 || /[/\\?#]/.test(name)) {
    return {
      ok: false,
      error: 'evolution_instance must not contain / \\ ? # and must be under 100 characters',
    }
  }
  return { ok: true, name }
}

/**
 * Public origin of THIS deployment, for the webhook URL. Order:
 * NEXT_PUBLIC_SITE_URL → x-forwarded-host/proto → request origin.
 * Critical behind a reverse proxy: `request.url` would otherwise register
 * a webhook pointing at the internal upstream (e.g. localhost:PORT).
 */
export function resolvePublicOrigin(
  headers: Pick<Headers, 'get'>,
  requestUrl: string,
  siteUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  if (siteUrl && siteUrl.trim()) return siteUrl.trim().replace(/\/+$/, '')
  const host = headers.get('x-forwarded-host')
  if (host) {
    const proto = headers.get('x-forwarded-proto') ?? 'https'
    return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`
  }
  return new URL(requestUrl).origin
}

export function generateWebhookToken(): string {
  return randomBytes(24).toString('base64url')
}

export interface WebhookRegistration {
  /** Plaintext token — only ever used to build the URL; never persisted. */
  token: string
  tokenHash: string
  webhookUrl: string
  /** Set when /webhook/set succeeded; null otherwise. */
  setAt: string | null
  /** Failure text (does NOT block the save). */
  error: string | null
}

/**
 * Generate a fresh token and register the webhook. Regenerating on every
 * save rotates the token — the standard "repair" if the webhook breaks.
 */
export async function registerEvolutionWebhook(
  creds: EvolutionCreds,
  origin: string,
  register: typeof setWebhook = setWebhook,
): Promise<WebhookRegistration> {
  const token = generateWebhookToken()
  const webhookUrl = `${origin}/api/whatsapp/evolution/webhook/${token}`
  const base = { token, tokenHash: hashWebhookToken(token), webhookUrl }
  try {
    await register({
      ...creds,
      url: webhookUrl,
      events: EVOLUTION_WEBHOOK_EVENTS,
      headers: { 'x-webhook-secret': token },
    })
    return { ...base, setAt: new Date().toISOString(), error: null }
  } catch (err) {
    return {
      ...base,
      setAt: null,
      error: err instanceof Error ? err.message : 'Failed to register webhook',
    }
  }
}

/** Best-effort: stop the instance posting before the row is dropped. */
export async function clearEvolutionWebhook(
  creds: EvolutionCreds,
  register: typeof setWebhook = setWebhook,
): Promise<void> {
  try {
    await register({ ...creds, url: '', events: [], enabled: false })
  } catch (err) {
    console.warn(
      '[evolution] could not clear webhook (continuing):',
      err instanceof Error ? err.message : err,
    )
  }
}

/** Columns that must be nulled when an account is on Meta. */
export const EVOLUTION_COLUMNS_CLEARED = {
  evolution_server_url: null,
  evolution_instance: null,
  evolution_api_key: null,
  evolution_webhook_token_hash: null,
  evolution_webhook_set_at: null,
} as const

/** Columns that must be nulled when an account is on Evolution. */
export const META_COLUMNS_CLEARED = {
  phone_number_id: null,
  waba_id: null,
  access_token: null,
  verify_token: null,
  registered_at: null,
  subscribed_apps_at: null,
  last_registration_error: null,
} as const
