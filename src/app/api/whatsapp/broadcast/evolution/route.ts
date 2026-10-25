// ============================================================
// POST /api/whatsapp/broadcast/evolution
//
// Creates a free-text, PACED campaign for accounts on the Evolution
// provider and starts it. Nothing is sent from this request: it only
// resolves the audience, stores the campaign + one pending recipient
// per contact, and flags the campaign `sending`. The paced sender
// (`tickBroadcast`) delivers them one by one.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  resolveAudienceContacts,
  type AudienceConfig,
  type CsvAudienceRow,
} from '@/lib/broadcast-audience'
import { normalizeKey } from '@/lib/contacts/dedupe'
import { fetchAllInChunks } from '@/lib/supabase/paged-query'
import { configProvider } from '@/lib/whatsapp/provider'
import {
  LIMITS,
  validateCampaignMessage,
  validatePacing,
} from '@/lib/whatsapp/evolution-broadcast-rules'
import type { Contact } from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'

const INSERT_CHUNK = 500

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`broadcast-evolution:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      name?: string
      message_text?: string
      message_link?: string
      message_image_url?: string
      audience?: AudienceConfig
      pacing?: Record<string, unknown>
    } | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const name = body.name?.trim()
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    if (!body.audience) {
      return NextResponse.json({ error: 'audience is required' }, { status: 400 })
    }

    const message = validateCampaignMessage({
      text: body.message_text ?? '',
      link: body.message_link,
      imageUrl: body.message_image_url,
    })
    if (!message.ok) return NextResponse.json({ error: message.error }, { status: 400 })

    const pacing = validatePacing(body.pacing)
    if (!pacing.ok) return NextResponse.json({ error: pacing.error }, { status: 400 })

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('provider, status')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config || configProvider(config) !== 'evolution') {
      return NextResponse.json(
        { error: 'Free-text campaigns require the Evolution provider', code: 'provider_not_supported' },
        { status: 400 },
      )
    }
    if (config.status !== 'connected') {
      return NextResponse.json(
        { error: 'The Evolution instance is not connected', code: 'whatsapp_not_connected' },
        { status: 400 },
      )
    }

    const contacts = (
      await resolveAudienceContacts(supabase, body.audience, (rows) =>
        upsertCsvContacts(supabase, accountId, userId, rows),
      )
    ).filter((c) => normalizeKey(c.phone ?? ''))

    if (contacts.length === 0) {
      return NextResponse.json({ error: 'No contacts with a phone number match this audience' }, { status: 400 })
    }
    if (contacts.length > LIMITS.RECIPIENTS_MAX) {
      return NextResponse.json(
        { error: `A campaign is capped at ${LIMITS.RECIPIENTS_MAX} recipients; narrow the audience` },
        { status: 400 },
      )
    }

    const { data: broadcast, error: createError } = await supabase
      .from('broadcasts')
      .insert({
        account_id: accountId,
        user_id: userId,
        name,
        channel: 'evolution_text',
        // template_name is NOT NULL from migration 001; a free-text
        // campaign has none.
        template_name: '(free text)',
        template_language: 'pt_BR',
        message_text: body.message_text?.trim() || null,
        message_link: body.message_link?.trim() || null,
        message_image_url: body.message_image_url?.trim() || null,
        pacing: pacing.pacing,
        audience_filter: body.audience,
        status: 'sending',
        total_recipients: contacts.length,
        next_send_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (createError || !broadcast) {
      console.error('[broadcast/evolution] create failed:', createError)
      return NextResponse.json({ error: 'Failed to create the campaign' }, { status: 500 })
    }

    for (let i = 0; i < contacts.length; i += INSERT_CHUNK) {
      const rows = contacts.slice(i, i + INSERT_CHUNK).map((c) => ({
        broadcast_id: broadcast.id,
        contact_id: c.id,
        status: 'pending',
      }))
      const { error } = await supabase.from('broadcast_recipients').insert(rows)
      if (error) {
        console.error('[broadcast/evolution] recipients insert failed:', error)
        // No orphan campaign with half its recipients.
        await supabase.from('broadcasts').delete().eq('id', broadcast.id)
        return NextResponse.json({ error: 'Failed to store the recipients' }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: true,
      broadcast_id: broadcast.id,
      total_recipients: contacts.length,
    })
  } catch (error) {
    console.error('Error in Evolution broadcast POST:', error)
    return toErrorResponse(error)
  }
}

/**
 * CSV rows arrive as raw phone/name pairs; recipients need real
 * contacts.id UUIDs. Look up by NORMALIZED phone (the key of the
 * account-wide unique index), insert what is missing.
 */
async function upsertCsvContacts(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  rows: CsvAudienceRow[],
): Promise<Contact[]> {
  const byKey = new Map<string, CsvAudienceRow>()
  for (const row of rows) {
    const key = normalizeKey(row.phone)
    if (key && !byKey.has(key)) byKey.set(key, row)
  }
  const keys = [...byKey.keys()]
  if (keys.length === 0) return []

  const existing = await fetchAllInChunks<Contact, string>(keys, (slice, from, to) =>
    db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone_normalized', slice)
      .order('id')
      .range(from, to),
  )
  const found = new Map<string, Contact>()
  for (const c of existing) {
    const key = normalizeKey(c.phone ?? '')
    if (key) found.set(key, c)
  }

  const missing = keys
    .filter((k) => !found.has(k))
    .map((k) => ({
      account_id: accountId,
      user_id: userId,
      phone: byKey.get(k)!.phone,
      name: byKey.get(k)!.name ?? null,
    }))
  for (let i = 0; i < missing.length; i += 200) {
    const { data, error } = await db.from('contacts').insert(missing.slice(i, i + 200)).select()
    if (error) throw new Error(`Failed to create contacts from the CSV: ${error.message}`)
    for (const c of (data ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '')
      if (key) found.set(key, c)
    }
  }
  return keys.map((k) => found.get(k)).filter((c): c is Contact => Boolean(c))
}
