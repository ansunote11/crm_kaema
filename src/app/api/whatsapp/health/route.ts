import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { configProvider } from '@/lib/whatsapp/provider'
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api'
import {
  parseMessagingLimit,
  parseQualityRating,
  type PhoneHealth,
} from '@/lib/whatsapp/phone-health'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const CACHE_HEADERS = { 'Cache-Control': 'private, max-age=300' }

function reply(body: PhoneHealth) {
  return NextResponse.json(body, { headers: CACHE_HEADERS })
}

const EMPTY: Omit<PhoneHealth, 'state'> = {
  displayPhoneNumber: null,
  quality: 'UNKNOWN',
  limit: null,
}

export async function GET() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`whatsapp-health:${userId}`, RATE_LIMITS.whatsappHealth)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('provider, phone_number_id, access_token, status, evolution_instance')
      .eq('account_id', accountId)
      .maybeSingle()

    // Evolution has no quality rating / messaging limit — report the
    // instance link state only.
    if (config && configProvider(config) === 'evolution') {
      return reply({
        state: config.status === 'connected' ? 'connected' : 'disconnected',
        ...EMPTY,
        displayPhoneNumber:
          config.status === 'connected' ? (config.evolution_instance ?? null) : null,
      })
    }

    if (!config || config.status !== 'connected' || !config.phone_number_id) {
      return reply({ state: 'disconnected', ...EMPTY })
    }

    try {
      const info = await getPhoneNumberHealth({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      })
      return reply({
        state: 'connected',
        displayPhoneNumber: info.display_phone_number ?? null,
        quality: parseQualityRating(info.quality_rating),
        limit: parseMessagingLimit(info.whatsapp_business_manager_messaging_limit),
      })
    } catch (err) {
      console.error('[whatsapp/health] lookup failed:', err instanceof Error ? err.message : err)
      return reply({ state: 'unavailable', ...EMPTY })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
