// ============================================================
// Paced sender for free-text Evolution campaigns.
//
// `tickBroadcast` sends AT MOST ONE message and says how long to wait
// before the next tick. Drivers call it repeatedly:
//   - the campaign page, while it is open (POST .../tick),
//   - the in-process runner (src/instrumentation.ts) on a long-lived
//     server,
//   - the cron endpoint, on serverless hosts.
// A per-campaign mutex (broadcasts.delivery_locked_at) keeps those
// drivers from double-sending, and `next_send_at` is the single source
// of truth for pacing, so any mix of drivers stays within the limits.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  configProvider,
  evolutionCredsFromConfig,
  resolveSendProvider,
} from '@/lib/whatsapp/provider'
import { getConnectionState } from '@/lib/whatsapp/evolution-api'
import {
  composeText,
  pacingFromRow,
  randomDelayMs,
  rateLimitWaitMs,
  renderForContact,
  type Pacing,
} from '@/lib/whatsapp/evolution-broadcast-rules'

/** A lock older than this is a crashed pass, not a running one. */
const LOCK_STALE_MS = 90_000

export type TickState =
  | 'sent' // one message went out
  | 'failed' // one recipient failed; campaign continues
  | 'waiting' // pacing says not yet
  | 'paused' // the campaign paused itself (or was paused)
  | 'done' // nothing left to send
  | 'busy' // another driver holds the lock
  | 'inactive' // not a running Evolution campaign

export interface TickResult {
  state: TickState
  /** Suggested wait before the next tick, milliseconds. */
  nextInMs: number
  /** Human-readable cause for `paused` / `failed`. */
  reason?: string
}

interface BroadcastRow {
  id: string
  account_id: string
  status: string
  channel: string
  message_text: string | null
  message_link: string | null
  message_image_url: string | null
  pacing: unknown
  next_send_at: string | null
  consecutive_failures: number | null
}

const iso = (ms: number) => new Date(ms).toISOString()

export async function tickBroadcast(
  db: SupabaseClient,
  broadcastId: string,
  now: number = Date.now(),
  rng: () => number = Math.random,
): Promise<TickResult> {
  const { data: b } = await db
    .from('broadcasts')
    .select(
      'id, account_id, status, channel, message_text, message_link, message_image_url, pacing, next_send_at, consecutive_failures',
    )
    .eq('id', broadcastId)
    .maybeSingle<BroadcastRow>()
  if (!b || b.channel !== 'evolution_text' || b.status !== 'sending') {
    return { state: b?.status === 'paused' ? 'paused' : 'inactive', nextInMs: 30_000 }
  }

  // Claim the campaign. Conditional UPDATE = atomic: the loser's WHERE
  // simply does not match.
  const { data: claimed } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: iso(now) })
    .eq('id', b.id)
    .eq('status', 'sending')
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${iso(now - LOCK_STALE_MS)}`)
    .select('id')
  if (!claimed || claimed.length === 0) return { state: 'busy', nextInMs: 3_000 }

  try {
    return await tickLocked(db, b, now, rng)
  } finally {
    await db.from('broadcasts').update({ delivery_locked_at: null }).eq('id', b.id)
  }
}

async function tickLocked(
  db: SupabaseClient,
  b: BroadcastRow,
  now: number,
  rng: () => number,
): Promise<TickResult> {
  const pacing = pacingFromRow(b.pacing)

  // 1. Campaign-level delay between messages.
  if (b.next_send_at) {
    const due = Date.parse(b.next_send_at)
    if (due > now) return { state: 'waiting', nextInMs: due - now }
  }

  // 2. Account-wide per-minute / per-hour caps (a second campaign must
  //    not double the rate).
  const wait = await accountRateWait(db, b.account_id, now, pacing)
  if (wait > 0) {
    await db.from('broadcasts').update({ next_send_at: iso(now + wait) }).eq('id', b.id)
    return { state: 'waiting', nextInMs: wait }
  }

  // 3. Next recipient.
  const { data: recipient } = await db
    .from('broadcast_recipients')
    .select('id, contact_id')
    .eq('broadcast_id', b.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!recipient) {
    await db.from('broadcasts').update({ status: 'sent', next_send_at: null }).eq('id', b.id)
    return { state: 'done', nextInMs: 30_000 }
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select(
      'provider, evolution_server_url, evolution_instance, evolution_api_key',
    )
    .eq('account_id', b.account_id)
    .maybeSingle()
  if (!config || configProvider(config) !== 'evolution') {
    return pauseCampaign(db, b.id, 'The account is no longer connected to Evolution', 0)
  }

  const { data: contact } = recipient.contact_id
    ? await db.from('contacts').select('name, phone').eq('id', recipient.contact_id).maybeSingle()
    : { data: null }
  const phone = (contact?.phone ?? '').replace(/\D/g, '')
  if (!contact || !phone) {
    // A data problem, not a delivery one: it must not count toward the
    // automatic pause.
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Contact has no phone number' })
      .eq('id', recipient.id)
    return { state: 'failed', nextInMs: 0, reason: 'no_phone' }
  }

  const text = renderForContact(
    composeText(b.message_text ?? '', b.message_link),
    contact,
  )

  try {
    const provider = resolveSendProvider(config)
    const sent = b.message_image_url
      ? await provider.sendMedia({
          to: phone,
          kind: 'image',
          link: b.message_image_url,
          caption: text || undefined,
        })
      : await provider.sendText({ to: phone, text })

    await db
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        whatsapp_message_id: sent.messageId,
        sent_at: iso(Date.now()),
        error_message: null,
      })
      .eq('id', recipient.id)
    const delay = randomDelayMs(pacing, rng)
    await db
      .from('broadcasts')
      .update({ consecutive_failures: 0, next_send_at: iso(now + delay) })
      .eq('id', b.id)
    return { state: 'sent', nextInMs: delay }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: message.slice(0, 500) })
      .eq('id', recipient.id)

    const failures = (b.consecutive_failures ?? 0) + 1
    // An instance that dropped explains a run of failures better than
    // the individual errors do — and every further send would fail too.
    const down = await instanceIsDown(config)
    if (down || failures >= pacing.max_consecutive_failures) {
      const reason = down
        ? `Evolution instance is not connected (last error: ${message})`
        : `${failures} failures in a row (last error: ${message})`
      return pauseCampaign(db, b.id, reason, failures)
    }
    const delay = randomDelayMs(pacing, rng)
    await db
      .from('broadcasts')
      .update({ consecutive_failures: failures, next_send_at: iso(now + delay) })
      .eq('id', b.id)
    return { state: 'failed', nextInMs: delay, reason: message }
  }
}

async function pauseCampaign(
  db: SupabaseClient,
  id: string,
  reason: string,
  failures: number,
): Promise<TickResult> {
  await db
    .from('broadcasts')
    .update({ status: 'paused', pause_reason: reason, consecutive_failures: failures })
    .eq('id', id)
  return { state: 'paused', nextInMs: 30_000, reason }
}

async function instanceIsDown(config: Parameters<typeof evolutionCredsFromConfig>[0]): Promise<boolean> {
  try {
    return (await getConnectionState(evolutionCredsFromConfig(config))) !== 'open'
  } catch {
    // Cannot even ask: treat as down rather than keep hammering.
    return true
  }
}

async function accountRateWait(
  db: SupabaseClient,
  accountId: string,
  now: number,
  pacing: Pacing,
): Promise<number> {
  const { data: campaigns } = await db
    .from('broadcasts')
    .select('id')
    .eq('account_id', accountId)
    .eq('channel', 'evolution_text')
  const ids = (campaigns ?? []).map((c: { id: string }) => c.id)
  if (ids.length === 0) return 0

  const { data: recent } = await db
    .from('broadcast_recipients')
    .select('sent_at')
    .in('broadcast_id', ids)
    .gte('sent_at', iso(now - 3_600_000))
    .order('sent_at', { ascending: false })
    .limit(pacing.per_hour + 1)
  const times = (recent ?? [])
    .map((r: { sent_at: string | null }) => (r.sent_at ? Date.parse(r.sent_at) : NaN))
    .filter((t: number) => Number.isFinite(t))
  return rateLimitWaitMs(times, now, pacing)
}

/**
 * Drive every running Evolution campaign for up to `budgetMs`. Used by
 * the in-process runner and the cron endpoint. Returns how many
 * messages went out.
 */
export async function runDueBroadcasts(
  db: SupabaseClient,
  budgetMs: number,
): Promise<{ sent: number; campaigns: number }> {
  const deadline = Date.now() + budgetMs
  const { data: running } = await db
    .from('broadcasts')
    .select('id')
    .eq('channel', 'evolution_text')
    .eq('status', 'sending')
  const ids: string[] = (running ?? []).map((r: { id: string }) => r.id)
  let sent = 0

  for (const id of ids) {
    while (Date.now() < deadline) {
      const r = await tickBroadcast(db, id)
      if (r.state === 'sent') sent++
      if (r.state === 'sent' || r.state === 'failed' || r.state === 'waiting') {
        // Another message is only worth waiting for inside the budget.
        if (r.nextInMs > deadline - Date.now()) break
        await new Promise((res) => setTimeout(res, Math.max(0, r.nextInMs)))
        continue
      }
      break // done / paused / busy / inactive
    }
  }
  return { sent, campaigns: ids.length }
}
