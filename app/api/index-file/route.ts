import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText, chunkText } from '@/lib/gemini'

async function extractText(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  if (
    mimeType === 'text/plain' || 
    mimeType === 'text/csv' || 
    mimeType === 'application/json' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/x-markdown'
  ) {
    return buffer.toString('utf-8')
  }
  if (mimeType === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default
    const data = await pdfParse(buffer)
    return data.text
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }
  if (mimeType.startsWith('image/')) {
    return `[Image file: ${fileName}]`
  }
  return buffer.toString('utf-8')
}

export async function POST(req: NextRequest) {
  try {
    const { fileId } = await req.json()
    if (!fileId) return NextResponse.json({ error: 'fileId required' }, { status: 400 })

    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from('files').select('*').eq('id', fileId).single()
    if (fileError || !fileRecord) return NextResponse.json({ error: 'File not found' }, { status: 404 })

    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('knowledge-base').download(fileRecord.storage_path)
    if (storageError) throw storageError

    const buffer = Buffer.from(await storageData.arrayBuffer())
    const text = await extractText(buffer, fileRecord.type, fileRecord.name)
    const chunks = chunkText(text)

    if (chunks.length === 0) return NextResponse.json({ success: true, chunks: 0 })

    await supabaseAdmin.from('chunks').delete().eq('file_id', fileId)

    let indexed = 0
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i])
      const { error } = await supabaseAdmin.from('chunks').insert({
        file_id: fileId, content: chunks[i], embedding, chunk_index: i,
      })
      if (!error) indexed++
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 200))
    }

    return NextResponse.json({ success: true, chunks: indexed })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
