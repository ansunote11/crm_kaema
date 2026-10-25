import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBase64FromMediaMessage } from '@/lib/whatsapp/evolution-api'
import {
  configProvider,
  evolutionCredsFromConfig,
} from '@/lib/whatsapp/provider'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/whatsapp/evolution/media/[messageId]
 *
 * The Evolution webhook only carries encrypted `.enc` CDN URLs, so the
 * inbox stores THIS proxy URL and we ask the Evolution instance for the
 * decrypted bytes on every view.
 *
 * Tenancy is natural: a messageId from another instance is simply not in
 * this instance's store and the lookup fails.
 *
 * Window limitation: media is only decryptable while the message is still
 * in the instance's store. A RE-CREATED instance cannot serve the media
 * of its predecessor — anything that needs the binary (e.g. audio
 * transcription) must run on arrival, and a failure from days ago is
 * almost certainly permanent.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  try {
    const { messageId } = await params
    if (!messageId) {
      return NextResponse.json({ error: t('media.idRequired') }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: t('common.unauthorized') }, { status: 401 })
    }

    const limit = checkRateLimit(`whatsapp-media:${user.id}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: t('common.profileNotLinked') }, { status: 403 })
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select(
        'provider, evolution_server_url, evolution_instance, evolution_api_key',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || configProvider(config) !== 'evolution') {
      return NextResponse.json({ error: t('common.whatsappNotConfigured') }, { status: 404 })
    }

    let creds
    try {
      creds = evolutionCredsFromConfig(config)
    } catch {
      return NextResponse.json({ error: t('common.whatsappNotConfigured') }, { status: 404 })
    }

    let media
    try {
      media = await getBase64FromMediaMessage({ ...creds, messageId })
    } catch (err) {
      console.warn(
        '[evolution media] not available:',
        err instanceof Error ? err.message : err,
      )
      return NextResponse.json({ error: t('media.fetchFailed') }, { status: 404 })
    }

    const base64 = media.base64.replace(/^data:[^;]+;base64,/, '')
    const bytes = Buffer.from(base64, 'base64')
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': media.mimetype || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in Evolution media GET:', error)
    return NextResponse.json({ error: t('media.fetchFailed') }, { status: 500 })
  }
}
