// ============================================================
// Evolution API (Baileys) client.
//
// Pure functions, each taking a single `{ serverUrl, instance,
// apiKey, ... }` object. Every send returns `{ messageId }` — the
// Baileys `key.id` — so callers treat it exactly like Meta's wamid.
//
// Docs for payload shapes drift per Evolution version, so error
// extraction and the webhook-set payload are deliberately defensive.
// ============================================================

export interface EvolutionCreds {
  serverUrl: string
  instance: string
  apiKey: string
}

export interface EvolutionSendResult {
  messageId: string
}

/** Strip any trailing slash so `${serverUrl}${path}` never double-slashes. */
export function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '')
}

/** Pull the most useful message out of the formats Evolution returns. */
export function extractEvolutionError(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const response = d.response as Record<string, unknown> | undefined
    const candidates: unknown[] = [response?.message, d.message, d.error]
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        return c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')
      }
      if (typeof c === 'string' && c) return c
      if (c && typeof c === 'object') return JSON.stringify(c)
    }
  }
  return `Evolution API error: ${status}`
}

/**
 * `{serverUrl}{path}/{instance}` with the apikey header. Throws an
 * `Error` carrying the API's own message on any non-2xx.
 */
export async function evolutionFetch<T = unknown>(
  creds: EvolutionCreds,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${normalizeServerUrl(creds.serverUrl)}${path}/${encodeURIComponent(creds.instance)}`
  const response = await fetch(url, {
    method,
    headers: {
      apikey: creds.apiKey,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // Empty / non-JSON body — fine for some endpoints.
  }
  if (!response.ok) {
    const err = new Error(extractEvolutionError(data, response.status))
    ;(err as Error & { status?: number }).status = response.status
    throw err
  }
  return data as T
}

/** `<digits>@s.whatsapp.net` — what reactions / quotes need. */
export function toJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`
}

function digits(phone: string): string {
  return phone.replace(/\D/g, '')
}

function messageIdFrom(data: unknown): string {
  const id = (data as { key?: { id?: string } } | null)?.key?.id
  if (!id) throw new Error('Evolution API did not return a message id')
  return id
}

function quoted(quotedMessageId?: string) {
  return quotedMessageId ? { quoted: { key: { id: quotedMessageId } } } : {}
}

export async function sendText(
  args: EvolutionCreds & { to: string; text: string; quotedMessageId?: string },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendText', {
    number: digits(args.to),
    text: args.text,
    ...quoted(args.quotedMessageId),
  })
  return { messageId: messageIdFrom(data) }
}

export type EvolutionMediaType = 'image' | 'video' | 'document'

export async function sendMedia(
  args: EvolutionCreds & {
    to: string
    mediatype: EvolutionMediaType
    media: string
    mimetype?: string
    caption?: string
    fileName?: string
    quotedMessageId?: string
  },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendMedia', {
    number: digits(args.to),
    mediatype: args.mediatype,
    media: args.media,
    ...(args.mimetype ? { mimetype: args.mimetype } : {}),
    ...(args.caption ? { caption: args.caption } : {}),
    ...(args.fileName ? { fileName: args.fileName } : {}),
    ...quoted(args.quotedMessageId),
  })
  return { messageId: messageIdFrom(data) }
}

/**
 * Voice note (PTT). Dedicated endpoint — it transcodes to OGG/Opus.
 * Never send audio through `sendMedia`.
 */
export async function sendAudio(
  args: EvolutionCreds & { to: string; audio: string; quotedMessageId?: string },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendWhatsAppAudio', {
    number: digits(args.to),
    audio: args.audio,
    ...quoted(args.quotedMessageId),
  })
  return { messageId: messageIdFrom(data) }
}

export async function sendReaction(
  args: EvolutionCreds & {
    to: string
    targetMessageId: string
    /** Whether the reacted-to message was sent by this instance. */
    fromMe: boolean
    /** Emoji, or '' to remove. */
    emoji: string
  },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendReaction', {
    key: {
      remoteJid: toJid(args.to),
      fromMe: args.fromMe,
      id: args.targetMessageId,
    },
    reaction: args.emoji,
  })
  // Reactions mint their own key but callers rarely need it.
  const id = (data as { key?: { id?: string } } | null)?.key?.id
  return { messageId: id ?? args.targetMessageId }
}

export async function sendButtons(
  args: EvolutionCreds & {
    to: string
    title: string
    description: string
    footer?: string
    buttons: { id: string; title: string }[]
  },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendButtons', {
    number: digits(args.to),
    title: args.title,
    description: args.description,
    footer: args.footer ?? '',
    buttons: args.buttons.map((b) => ({
      type: 'reply',
      displayText: b.title,
      id: b.id,
    })),
  })
  return { messageId: messageIdFrom(data) }
}

export async function sendList(
  args: EvolutionCreds & {
    to: string
    title: string
    description: string
    buttonText: string
    footerText?: string
    sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[]
  },
): Promise<EvolutionSendResult> {
  const data = await evolutionFetch(args, 'POST', '/message/sendList', {
    number: digits(args.to),
    title: args.title,
    description: args.description,
    buttonText: args.buttonText,
    footerText: args.footerText ?? '',
    values: args.sections.map((s) => ({
      title: s.title ?? '',
      rows: s.rows.map((r) => ({
        title: r.title,
        description: r.description ?? '',
        rowId: r.id,
      })),
    })),
  })
  return { messageId: messageIdFrom(data) }
}

export type EvolutionConnectionState = 'open' | 'close' | 'connecting'

export async function getConnectionState(
  creds: EvolutionCreds,
): Promise<EvolutionConnectionState> {
  const data = await evolutionFetch<{
    instance?: { state?: string }
    state?: string
  }>(creds, 'GET', '/instance/connectionState')
  const state = data?.instance?.state ?? data?.state
  if (state === 'open' || state === 'connecting') return state
  return 'close'
}

export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
] as const

/**
 * Register (or, with `enabled:false`, clear) the instance webhook.
 *
 * - `byEvents` MUST stay false: when true Evolution suffixes the URL with
 *   the event name and destroys token-in-path routing.
 * - The payload shape varies by version: try the v2 envelope first and
 *   retry with the flat shape on a 400.
 */
export async function setWebhook(
  args: EvolutionCreds & {
    url: string
    events: readonly string[]
    enabled?: boolean
    headers?: Record<string, string>
  },
): Promise<void> {
  const enabled = args.enabled ?? true
  const headers = args.headers ?? {}
  try {
    await evolutionFetch(args, 'POST', '/webhook/set', {
      webhook: {
        enabled,
        url: args.url,
        byEvents: false,
        base64: false,
        headers,
        events: [...args.events],
      },
    })
  } catch (err) {
    if ((err as { status?: number }).status !== 400) throw err
    await evolutionFetch(args, 'POST', '/webhook/set', {
      enabled,
      url: args.url,
      webhookByEvents: false,
      webhookBase64: false,
      headers,
      events: [...args.events],
    })
  }
}

export interface EvolutionJids {
  /** `<digits>@s.whatsapp.net`, when known. */
  phoneJid: string | null
  /** `<id>@lid`, when known. */
  lidJid: string | null
}

/**
 * Read the raw message row from the Evolution store to recover BOTH
 * JIDs. The webhook overwrites `key.remoteJid` with `remoteJidAlt`, so
 * only one identity reaches us; the stored row keeps both. Classified by
 * JID suffix, never by position (some builds swap them).
 */
export async function findMessageJids(
  args: EvolutionCreds & { messageId: string },
): Promise<EvolutionJids> {
  const data = await evolutionFetch<unknown>(args, 'POST', '/chat/findMessages', {
    where: { key: { id: args.messageId } },
  })
  const records = Array.isArray(data)
    ? data
    : ((data as { messages?: { records?: unknown[] } })?.messages?.records ?? [])
  const out: EvolutionJids = { phoneJid: null, lidJid: null }
  for (const rec of records as { key?: Record<string, unknown> }[]) {
    const key = rec?.key
    if (!key) continue
    for (const v of [key.remoteJid, key.remoteJidAlt]) {
      if (typeof v !== 'string') continue
      if (v.endsWith('@s.whatsapp.net') && !out.phoneJid) out.phoneJid = v
      else if (v.endsWith('@lid') && !out.lidJid) out.lidJid = v
    }
  }
  return out
}

/** Decrypted media for a received message, as base64. */
export async function getBase64FromMediaMessage(
  args: EvolutionCreds & { messageId: string; convertToMp4?: boolean },
): Promise<{ base64: string; mimetype: string | null; fileName: string | null }> {
  const data = await evolutionFetch<{
    base64?: string
    mimetype?: string
    fileName?: string
  }>(args, 'POST', '/chat/getBase64FromMediaMessage', {
    message: { key: { id: args.messageId } },
    convertToMp4: args.convertToMp4 ?? false,
  })
  if (!data?.base64) throw new Error('Evolution API returned no media')
  return {
    base64: data.base64,
    mimetype: data.mimetype ?? null,
    fileName: data.fileName ?? null,
  }
}
