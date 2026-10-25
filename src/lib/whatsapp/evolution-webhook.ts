// ============================================================
// Evolution webhook event handling (provider adapter).
//
// The route authenticates the request (token-in-path hash), resolves
// the owning `whatsapp_config` row, and hands the parsed body here.
// Customer messages are normalized and sent through the SHARED
// pipeline; `fromMe` echoes get their own light path (see below).
// ============================================================

import { createHash, timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  findOrCreateContact,
  findOrCreateConversation,
  processNormalizedInbound,
} from '@/lib/whatsapp/inbound-pipeline'
import {
  connectionStateToStatus,
  evolutionContent,
  evolutionIdentity,
  evolutionTimestampToIso,
  extractStatusUpdates,
  isGroupJid,
  normalizeEventName,
  parseEvolutionMessage,
  resolvePeer,
  type EvolutionMessageData,
} from '@/lib/whatsapp/evolution-inbound'
import { applyMessageStatus } from '@/lib/whatsapp/message-status-sync'
import { applyBroadcastRecipientStatus } from '@/lib/whatsapp/broadcast-recipient-webhook'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { decrypt } from '@/lib/whatsapp/encryption'

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare for the optional `x-webhook-secret` header. */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface EvolutionConfigRow {
  id: string
  account_id: string
  user_id: string
  status?: string | null
  evolution_server_url: string
  evolution_instance: string
  evolution_api_key: string
}

export interface EvolutionWebhookBody {
  event?: string
  instance?: string
  data?: unknown
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location', 'interactive',
])

function storedContentType(type: string): string {
  if (ALLOWED_CONTENT_TYPES.has(type)) return type
  return type === 'sticker' ? 'image' : 'text'
}

export async function handleEvolutionEvent(
  config: EvolutionConfigRow,
  body: EvolutionWebhookBody,
  db: SupabaseClient = supabaseAdmin(),
): Promise<void> {
  switch (normalizeEventName(body.event)) {
    case 'connection.update':
      return handleConnectionUpdate(config, body.data, db)
    case 'messages.update':
      return handleMessagesUpdate(config, body.data, db)
    case 'messages.upsert': {
      const items = Array.isArray(body.data) ? body.data : body.data ? [body.data] : []
      for (const item of items) {
        await handleUpsert(config, item as EvolutionMessageData, db)
      }
      return
    }
    default:
      // qrcode.updated and friends — nothing to do.
      return
  }
}

async function handleConnectionUpdate(
  config: EvolutionConfigRow,
  data: unknown,
  db: SupabaseClient,
) {
  const next = connectionStateToStatus(data as { state?: string })
  if (next === config.status) return
  const { error } = await db
    .from('whatsapp_config')
    .update({
      status: next,
      ...(next === 'connected' ? { connected_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)
  if (error) console.error('[evolution] connection.update write failed:', error.message)
}

async function handleMessagesUpdate(
  config: EvolutionConfigRow,
  data: unknown,
  db: SupabaseClient,
) {
  for (const update of extractStatusUpdates(data)) {
    const advanced = await applyMessageStatus(db, config.account_id, {
      wamid: update.messageId,
      status: update.status,
      failure: null,
      statusAt: null,
    })
    // Free-text campaigns: mirror delivered / read onto the recipient row
    // (the aggregate trigger then advances the campaign's counters).
    await applyBroadcastRecipientStatus(db, {
      whatsappMessageId: update.messageId,
      status: update.status,
      occurredAt: new Date().toISOString(),
      failure: null,
    }).catch((err) => console.error('[evolution] recipient status mirror failed:', err))
    for (const a of advanced) {
      await dispatchWebhookEvent(db, config.account_id, 'message.status_updated', {
        whatsapp_message_id: update.messageId,
        conversation_id: a.conversation_id,
        status: update.status,
      })
    }
  }
}

async function handleUpsert(
  config: EvolutionConfigRow,
  data: EvolutionMessageData,
  db: SupabaseClient,
) {
  const key = data.key
  if (!key?.id) return
  // Groups are out of scope for the 1:1 inbox.
  if (isGroupJid(key.remoteJid) || isGroupJid(key.remoteJidAlt)) return

  const fromMe = key.fromMe === true
  const parsed = parseEvolutionMessage(data)
  // Reactions we sent ourselves (fromMe) are ignored in v1.
  if (fromMe && parsed.type === 'reaction') return

  const peer = await resolvePeer(key, {
    serverUrl: config.evolution_server_url,
    instance: config.evolution_instance,
    apiKey: decryptKey(config.evolution_api_key),
  })
  if (!peer || (!peer.phone && !peer.lidJid)) {
    console.warn('[evolution] message without a usable peer; skipping:', key.id)
    return
  }

  const identity = evolutionIdentity(peer, data.pushName, fromMe)
  const timestamp = evolutionTimestampToIso(data.messageTimestamp)

  if (fromMe) {
    await handleEcho(config, key.id, parsed, identity, timestamp, db)
    return
  }

  await processNormalizedInbound({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    inbound: {
      externalMessageId: key.id,
      type: parsed.type === 'unknown' ? 'text' : parsed.type,
      timestamp,
      identity,
      reaction: parsed.reaction ?? undefined,
      replyToExternalId: parsed.replyToId,
      content: evolutionContent(parsed, key.id),
      textBody: parsed.text,
    },
  })
}

function decryptKey(encrypted: string): string {
  try {
    return decrypt(encrypted)
  } catch {
    return ''
  }
}

/**
 * `fromMe` echo — either a CRM send coming back, or a reply typed on the
 * paired phone. Rules (they prevent loops with the operator):
 *   - dedupe by key.id: every CRM send echoes back and is already stored;
 *   - persist as sender_type 'agent', NEVER touch unread_count;
 *   - NO fan-out to automations / flows / AI / public webhooks;
 *   - the peer is the customer, never use pushName as their name;
 *   - a human answering from the phone pauses active flow runs.
 */
async function handleEcho(
  config: EvolutionConfigRow,
  messageId: string,
  parsed: ReturnType<typeof parseEvolutionMessage>,
  identity: ReturnType<typeof evolutionIdentity>,
  timestamp: string,
  db: SupabaseClient,
) {
  const accountId = config.account_id

  const contactOutcome = await findOrCreateContact(accountId, config.user_id, identity)
  if (!contactOutcome) return
  const convResult = await findOrCreateConversation(
    accountId,
    config.user_id,
    contactOutcome.contact.id,
  )
  if (!convResult) return
  const conversation = convResult.conversation

  const { data: existing } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', messageId)
    .maybeSingle()
  if (existing) return

  const content = evolutionContent(parsed, messageId)
  const type = parsed.type === 'unknown' ? 'text' : parsed.type

  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: storedContentType(type),
        content_text: content.contentText,
        media_url: content.mediaUrl,
        media_type: content.mediaType,
        message_id: messageId,
        status: 'sent',
        created_at: timestamp,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')
  if (error) {
    console.error('[evolution] echo insert failed:', error.message)
    return
  }
  // Lost a race with the CRM's own insert — it already owns the row.
  if (!inserted || inserted.length === 0) return

  await db
    .from('conversations')
    .update({
      last_message_text: content.contentText || `[${type}]`,
      last_message_at: timestamp,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // A human replied from the phone: same "yield, human is here" signal
  // as a send from the CRM.
  const { error: pauseErr } = await db
    .from('flow_runs')
    .update({
      status: 'paused_by_agent',
      ended_at: new Date().toISOString(),
      end_reason: 'agent_replied',
    })
    .eq('account_id', accountId)
    .eq('contact_id', contactOutcome.contact.id)
    .eq('status', 'active')
  if (pauseErr) console.error('[evolution] pause flow runs failed:', pauseErr.message)
}
