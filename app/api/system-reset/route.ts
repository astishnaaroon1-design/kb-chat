import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { data: files, error: filesError } = await supabaseAdmin
      .from('files')
      .select('storage_path')
    
    if (filesError) throw filesError

    if (files && files.length > 0) {
      const paths = files.map((f: any) => f.storage_path)
      const { error: storageError } = await supabaseAdmin.storage
        .from('knowledge-base')
        .remove(paths)
      if (storageError) console.error('Storage bucket cleanup warning:', storageError)
    }

    await supabaseAdmin.from('chunks').delete().gt('created_at', '1970-01-01')
    await supabaseAdmin.from('files').delete().gt('created_at', '1970-01-01')
    await supabaseAdmin.from('chat_messages').delete().gt('created_at', '1970-01-01')
    await supabaseAdmin.from('chat_sessions').delete().gt('created_at', '1970-01-01')
    await supabaseAdmin.from('memories').delete().gt('created_at', '1970-01-01')

    return NextResponse.json({ success: true, message: 'System reset completed successfully' })
  } catch (err: any) {
    console.error('System reset error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
