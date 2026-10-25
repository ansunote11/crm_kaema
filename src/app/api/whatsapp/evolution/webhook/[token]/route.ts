import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import {
  handleEvolutionEvent,
  hashWebhookToken,
  secretMatches,
  type EvolutionConfigRow,
  type EvolutionWebhookBody,
} from '@/lib/whatsapp/evolution-webhook'

// Inbound processing runs inside `after()` and can fan out to flows,
// automations and the AI reply; give it the same headroom as the Meta
// webhook.
export const maxDuration = 60

/**
 * POST /api/whatsapp/evolution/webhook/[token]
 *
 * Evolution does NOT sign its payloads (no HMAC). The random token in
 * the path is both the routing key and the authentication: we hash it
 * and look the owning config up by `evolution_webhook_token_hash` with
 * the service-role client (there is no user session here). No match →
 * 401, fail-closed.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select(
      'id, account_id, user_id, status, evolution_server_url, evolution_instance, evolution_api_key',
    )
    .eq('provider', 'evolution')
    .eq('evolution_webhook_token_hash', hashWebhookToken(token))
    .maybeSingle()

  if (error || !config) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Defense in depth: the token is also registered as `x-webhook-secret`.
  // Not every Evolution build forwards custom headers, so tolerate its
  // absence — the hash in the path is the real authentication.
  const secret = request.headers.get('x-webhook-secret')
  if (secret && !secretMatches(secret, token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawBody = await readCappedBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  let body: EvolutionWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack fast, work in after() so the function stays alive until done.
  after(async () => {
    try {
      await handleEvolutionEvent(config as EvolutionConfigRow, body)
    } catch (err) {
      console.error('[evolution] webhook processing failed:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
