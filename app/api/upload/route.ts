import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    const allowedTypes = [
      'text/plain', 
      'text/csv', 
      'application/pdf',
      'image/png', 
      'image/jpeg', 
      'image/webp', 
      'application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/markdown',
      'text/x-markdown'
    ]

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: `File type "${file.type || 'unknown'}" is not supported` }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const storagePath = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

    const { error: storageError } = await supabaseAdmin.storage
      .from('knowledge-base')
      .upload(storagePath, buffer, { contentType: file.type })
    if (storageError) throw storageError

    const { data: fileRecord, error: dbError } = await supabaseAdmin
      .from('files')
      .insert({ name: file.name, type: file.type, size: file.size, storage_path: storagePath })
      .select().single()
    if (dbError) throw dbError

    return NextResponse.json({ success: true, file: fileRecord })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
