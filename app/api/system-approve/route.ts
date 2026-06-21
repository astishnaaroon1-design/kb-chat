import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'edge'

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json()
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    console.log(`System Approve: Unlocking gate for session: ${sessionId}`)

    // 1. Update the session stage to 'running' and clear pending_approval
    const { error: updateError } = await supabaseAdmin
      .from('chat_sessions')
      .update({
        active_stage: 'running',
        pending_approval: false
      })
      .eq('id', sessionId)

    if (updateError) throw updateError

    // 2. Immediately trigger the Supervisor Agent to start the employees!
    fetch(`${protocol}://${host}/api/agents/supervisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Error starting supervisor from manual approval:', err))

    return NextResponse.json({ success: true, message: 'Pipeline unlocked. Supervisor notified.' })
  } catch (err: any) {
    console.error('System approval error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
