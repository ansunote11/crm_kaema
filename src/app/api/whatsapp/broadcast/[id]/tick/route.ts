// POST /api/whatsapp/broadcast/[id]/tick
//
// Advances a running free-text (Evolution) campaign by AT MOST one
// message and says how long to wait before calling again. The campaign
// page calls it in a loop while it is open; the in-process runner and
// the cron endpoint drive the same function when nobody is looking.
// Pacing lives in the database (`next_send_at`), so extra callers cannot
// make the campaign go faster than its limits.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { tickBroadcast } from '@/lib/whatsapp/evolution-broadcast'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Sending is a write: viewers are read-only.
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    // RLS-scoped read proves the campaign belongs to the caller's account.
    const { data: owned } = await supabase
      .from('broadcasts')
      .select('id, channel')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!owned || owned.channel !== 'evolution_text') {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const result = await tickBroadcast(supabaseAdmin(), id)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error in broadcast tick:', error)
    return toErrorResponse(error)
  }
}
