// ============================================================
// Evolution (Baileys) webhook normalization — pure, unit-testable.
//
// Turns an Evolution `messages.upsert` / `messages.update` /
// `connection.update` payload into the provider-neutral shapes the
// shared pipeline understands. No DB access here, except the LID
// resolver which takes an injectable lookup.
// ============================================================

import type { WaIdentity } from '@/lib/whatsapp/wa-identity'
import type { ParsedContent } from '@/lib/whatsapp/inbound-pipeline'
import type { MessageStatus } from '@/types'
import {
  findMessageJids,
  type EvolutionCreds,
  type EvolutionJids,
} from '@/lib/whatsapp/evolution-api'

/** `MESSAGES_UPSERT` -> `messages.upsert`. */
export function normalizeEventName(event: unknown): string {
  return typeof event === 'string' ? event.toLowerCase().replace(/_/g, '.') : ''
}

export interface EvolutionKey {
  remoteJid?: string
  remoteJidAlt?: string
  fromMe?: boolean
  id?: string
  participant?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface EvolutionMessageData {
  key?: EvolutionKey
  pushName?: string
  message?: Record<string, any>
  messageType?: string
  messageTimestamp?: number | string | { low?: number }
  contextInfo?: Record<string, any>
  [k: string]: any
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Baileys timestamps arrive as number, numeric string or Long `{low}`. */
export function evolutionTimestampToIso(ts: unknown, now = Date.now()): string {
  let seconds: number | null = null
  if (typeof ts === 'number') seconds = ts
  else if (typeof ts === 'string' && ts.trim() !== '') seconds = Number(ts)
  else if (ts && typeof ts === 'object' && typeof (ts as { low?: number }).low === 'number') {
    seconds = (ts as { low: number }).low
  }
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return new Date(now).toISOString()
  }
  return new Date(seconds * 1000).toISOString()
}

export function isGroupJid(jid: string | undefined | null): boolean {
  return !!jid && jid.endsWith('@g.us')
}

export function isLidJid(jid: string | undefined | null): boolean {
  return !!jid && jid.endsWith('@lid')
}

/** Digits of a `<digits>@s.whatsapp.net` JID; null for anything else. */
export function jidToPhone(jid: string | undefined | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '')
  return digits || null
}

export interface ParsedEvolutionMessage {
  /** Meta-vocabulary type understood by the shared pipeline. */
  type: string
  text: string | null
  caption: string | null
  mimetype: string | null
  fileName: string | null
  /** Reply button / list row id the customer tapped. */
  interactiveReplyId: string | null
  reaction: { targetMessageId: string; emoji: string } | null
  replyToId: string | null
  hasMedia: boolean
}

/**
 * Classify the Baileys `message` envelope. Ephemeral / view-once wrappers
 * are unwrapped first. Unknown shapes become type 'unknown'.
 */
export function parseEvolutionMessage(data: EvolutionMessageData): ParsedEvolutionMessage {
  let m = data.message ?? {}
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    if (m[wrapper]?.message) m = m[wrapper].message
  }

  // Click-to-WhatsApp card: for a first CTWA message the card sits in
  // `data.contextInfo`, NOT inside extendedTextMessage — fall back to it.
  const ctx =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.audioMessage?.contextInfo ??
    m.stickerMessage?.contextInfo ??
    data.contextInfo ??
    data.message?.messageContextInfo ??
    null
  const replyToId: string | null = ctx?.stanzaId ?? null

  const base: ParsedEvolutionMessage = {
    type: 'unknown',
    text: null,
    caption: null,
    mimetype: null,
    fileName: null,
    interactiveReplyId: null,
    reaction: null,
    replyToId,
    hasMedia: false,
  }

  if (typeof m.conversation === 'string') {
    return { ...base, type: 'text', text: m.conversation }
  }
  if (m.extendedTextMessage) {
    return { ...base, type: 'text', text: m.extendedTextMessage.text ?? null }
  }
  if (m.imageMessage) {
    return {
      ...base,
      type: 'image',
      caption: m.imageMessage.caption ?? null,
      mimetype: m.imageMessage.mimetype ?? null,
      hasMedia: true,
    }
  }
  if (m.videoMessage) {
    return {
      ...base,
      type: 'video',
      caption: m.videoMessage.caption ?? null,
      mimetype: m.videoMessage.mimetype ?? null,
      hasMedia: true,
    }
  }
  if (m.documentMessage) {
    return {
      ...base,
      type: 'document',
      caption: m.documentMessage.caption ?? null,
      mimetype: m.documentMessage.mimetype ?? null,
      fileName: m.documentMessage.fileName ?? null,
      hasMedia: true,
    }
  }
  if (m.audioMessage) {
    return {
      ...base,
      type: 'audio',
      mimetype: m.audioMessage.mimetype ?? null,
      hasMedia: true,
    }
  }
  if (m.stickerMessage) {
    return {
      ...base,
      type: 'sticker',
      mimetype: m.stickerMessage.mimetype ?? 'image/webp',
      hasMedia: true,
    }
  }
  if (m.locationMessage) {
    const l = m.locationMessage
    const text = [l.name, l.address, `${l.degreesLatitude},${l.degreesLongitude}`]
      .filter(Boolean)
      .join(' - ')
    return { ...base, type: 'location', text }
  }
  if (m.reactionMessage) {
    const targetId = m.reactionMessage.key?.id
    return {
      ...base,
      type: 'reaction',
      reaction: targetId
        ? { targetMessageId: targetId, emoji: m.reactionMessage.text ?? '' }
        : null,
    }
  }
  if (m.buttonsResponseMessage) {
    const b = m.buttonsResponseMessage
    return {
      ...base,
      type: 'interactive',
      text: b.selectedDisplayText ?? b.selectedButtonId ?? null,
      interactiveReplyId: b.selectedButtonId ?? null,
    }
  }
  if (m.listResponseMessage) {
    const l = m.listResponseMessage
    return {
      ...base,
      type: 'interactive',
      text: l.title ?? null,
      interactiveReplyId: l.singleSelectReply?.selectedRowId ?? null,
    }
  }
  if (m.templateButtonReplyMessage) {
    const t = m.templateButtonReplyMessage
    return {
      ...base,
      type: 'interactive',
      text: t.selectedDisplayText ?? t.selectedId ?? null,
      interactiveReplyId: t.selectedId ?? null,
    }
  }
  return base
}

/** Proxy URL persisted as `messages.media_url` (see the media route). */
export function evolutionMediaProxyUrl(messageId: string): string {
  return `/api/whatsapp/evolution/media/${encodeURIComponent(messageId)}`
}

/** Pipeline-ready content for a parsed Evolution message. */
export function evolutionContent(
  parsed: ParsedEvolutionMessage,
  externalMessageId: string,
): ParsedContent {
  const empty: ParsedContent = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }
  if (parsed.hasMedia) {
    return {
      ...empty,
      contentText:
        parsed.type === 'document'
          ? (parsed.caption ?? parsed.fileName)
          : parsed.caption,
      mediaUrl: evolutionMediaProxyUrl(externalMessageId),
      mediaType: parsed.mimetype,
    }
  }
  if (parsed.type === 'interactive') {
    return {
      ...empty,
      contentText: parsed.text ?? '[Interactive reply]',
      interactiveReplyId: parsed.interactiveReplyId,
    }
  }
  if (parsed.type === 'unknown') {
    return { ...empty, contentText: '[Unsupported message type]' }
  }
  return { ...empty, contentText: parsed.text }
}

// ------------------------------------------------------------
// LID / phone resolution
// ------------------------------------------------------------

type JidLookup = (messageId: string) => Promise<EvolutionJids>

interface CacheEntry {
  jids: EvolutionJids
  expires: number
}
const JID_CACHE = new Map<string, CacheEntry>()
const JID_CACHE_TTL_MS = 5 * 60 * 1000

/** Test hook. */
export function clearJidCache(): void {
  JID_CACHE.clear()
}

export interface ResolvedPeer {
  phone: string
  /** `<id>@lid` when that is the only identity we could recover. */
  lidJid: string | null
}

/**
 * Work out who the peer is. Evolution overwrites `key.remoteJid` with
 * `key.remoteJidAlt`, so the payload usually carries a single identity.
 * If it is a phone JID we are done. If it is a LID (or only the Alt is
 * set) ask the Evolution store — which keeps BOTH — for the row, and
 * classify by JID SUFFIX, never by position.
 *
 * Best-effort and NEVER throws: losing the phone costs a duplicate
 * contact (merged later); throwing would cost the customer's message.
 * Cache is keyed by server+instance+jid (a LID is relative to the
 * observing account) with a short TTL.
 */
export async function resolvePeer(
  key: EvolutionKey,
  creds: Pick<EvolutionCreds, 'serverUrl' | 'instance'> & Partial<EvolutionCreds>,
  lookup?: JidLookup,
  now = Date.now(),
): Promise<ResolvedPeer | null> {
  const candidates = [key.remoteJid, key.remoteJidAlt].filter(
    (j): j is string => typeof j === 'string' && j.length > 0,
  )
  for (const jid of candidates) {
    const phone = jidToPhone(jid)
    if (phone) return { phone, lidJid: candidates.find(isLidJid) ?? null }
  }

  const lid = candidates.find(isLidJid) ?? null
  if (!lid) return null

  const cacheKey = `${creds.serverUrl}|${creds.instance}|${lid}`
  const hit = JID_CACHE.get(cacheKey)
  if (hit && hit.expires > now) {
    const phone = jidToPhone(hit.jids.phoneJid)
    return phone ? { phone, lidJid: lid } : { phone: '', lidJid: lid }
  }

  let jids: EvolutionJids = { phoneJid: null, lidJid: null }
  if (key.id) {
    try {
      const run: JidLookup =
        lookup ??
        ((messageId) => findMessageJids({ ...(creds as EvolutionCreds), messageId }))
      jids = await run(key.id)
    } catch (err) {
      console.warn(
        '[evolution] LID resolution failed (continuing with LID only):',
        err instanceof Error ? err.message : err,
      )
    }
  }
  JID_CACHE.set(cacheKey, { jids, expires: now + JID_CACHE_TTL_MS })
  const phone = jidToPhone(jids.phoneJid)
  return { phone: phone ?? '', lidJid: lid }
}

/** Build the shared identity. `fromMe` echoes must not take pushName. */
export function evolutionIdentity(
  peer: ResolvedPeer,
  pushName: string | undefined,
  fromMe: boolean,
): WaIdentity {
  return {
    phone: peer.phone,
    // A LID with no recoverable phone is stored in the BSUID column so
    // the contact still has a stable, unique key.
    waUserId: peer.phone ? null : peer.lidJid,
    waParentUserId: null,
    waUsername: null,
    // In a fromMe echo, pushName is the OPERATOR's name, not the customer's.
    name: fromMe ? '' : (pushName ?? ''),
  }
}

// ------------------------------------------------------------
// messages.update / connection.update
// ------------------------------------------------------------

const STATUS_MAP: Record<string, MessageStatus> = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
}

export interface EvolutionStatusUpdate {
  messageId: string
  status: MessageStatus
}

/** Accepts a single update or an array; drops unknown statuses. */
export function extractStatusUpdates(data: unknown): EvolutionStatusUpdate[] {
  const items = Array.isArray(data) ? data : data ? [data] : []
  const out: EvolutionStatusUpdate[] = []
  for (const raw of items) {
    const item = raw as {
      keyId?: string
      messageId?: string
      key?: { id?: string }
      status?: string
    }
    const id = item.keyId ?? item.key?.id ?? item.messageId
    const status = item.status ? STATUS_MAP[String(item.status).toUpperCase()] : undefined
    if (id && status) out.push({ messageId: id, status })
  }
  return out
}

/** `open` -> connected; anything else -> disconnected. */
export function connectionStateToStatus(
  data: { state?: string } | null | undefined,
): 'connected' | 'disconnected' {
  return data?.state === 'open' ? 'connected' : 'disconnected'
}
