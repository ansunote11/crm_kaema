// POST /api/whatsapp/broadcast/[id]/control
//
// Body: { action: 'pause' | 'resume' | 'retry_failed' }
//
// Operator controls for a free-text (Evolution) campaign:
//   pause         stop sending after the message in flight.
//   resume        clear the pause (manual or automatic) and keep going.
//   retry_failed  put failed recipients back in the queue, then resume.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'

const ACTIONS = ['pause', 'resume', 'retry_failed'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => ({}))) as { action?: string }
    const action = body.action as Action
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const { data: b } = await supabase
      .from('broadcasts')
      .select('id, channel, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!b || b.channel !== 'evolution_text') {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (action === 'pause') {
      if (b.status !== 'sending') {
        return NextResponse.json({ error: 'Only a running campaign can be paused' }, { status: 409 })
      }
      await supabase
        .from('broadcasts')
        .update({ status: 'paused', pause_reason: 'manual' })
        .eq('id', id)
      return NextResponse.json({ success: true, status: 'paused' })
    }

    if (action === 'retry_failed') {
      // The aggregate trigger moves failed_count back down as rows leave
      // the failed state.
      const { error } = await supabase
        .from('broadcast_recipients')
        .update({ status: 'pending', error_message: null })
        .eq('broadcast_id', id)
        .eq('status', 'failed')
      if (error) {
        return NextResponse.json({ error: 'Failed to requeue the failed recipients' }, { status: 500 })
      }
    }

    // resume / retry_failed: a campaign that already finished is only
    // restarted if something is pending again.
    if (b.status === 'sent') {
      const { count } = await supabase
        .from('broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', id)
        .eq('status', 'pending')
      if (!count) return NextResponse.json({ error: 'Nothing left to send' }, { status: 409 })
    }
    await supabase
      .from('broadcasts')
      .update({
        status: 'sending',
        pause_reason: null,
        consecutive_failures: 0,
        next_send_at: new Date().toISOString(),
      })
      .eq('id', id)
    return NextResponse.json({ success: true, status: 'sending' })
  } catch (error) {
    console.error('Error in broadcast control:', error)
    return toErrorResponse(error)
  }
}
