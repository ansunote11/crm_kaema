import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { runDueBroadcasts } from '@/lib/whatsapp/evolution-broadcast'

// One invocation can wait out several pacing delays.
export const maxDuration = 60

/**
 * Drive running free-text (Evolution) campaigns. For hosts where the
 * app is not a long-lived process (e.g. Vercel Cron, or an external
 * pinger every minute); a long-lived server already runs the same loop
 * from src/instrumentation.ts. Same shared secret as the automations
 * cron: `x-cron-secret` must match AUTOMATION_CRON_SECRET.
 *
 * Lives outside /api/whatsapp/ on purpose: that prefix demands a user
 * session in the middleware, and a cron has none.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await runDueBroadcasts(supabaseAdmin(), 50_000)
  return NextResponse.json(result)
}
