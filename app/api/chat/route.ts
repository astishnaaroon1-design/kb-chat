import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'nodejs'
export const maxDuration = 60

const FREE_MODELS = [
  'google/gemini-2.5-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'microsoft/phi-3-medium-128k-instruct:free',
  'openchat/openchat-7b:free'
]

export async function POST(req: NextRequest) {
  try {
    const { messages, question } = await req.json()
    if (!question) return new Response(JSON.stringify({ error: 'question required' }), { status: 400 })

    const queryEmbedding = await embedText(question)

    const { data: relevantChunks, error: searchError } = await supabaseAdmin.rpc('match_chunks_hybrid', {
      query_embedding: queryEmbedding,
      query_text: question,
      match_count: 5,
      vector_weight: 0.6,
      fts_weight: 0.4
    })
    if (searchError) throw searchError

    const { data: relevantMemories, error: memoryError } = await supabaseAdmin.rpc('match_memories', {
      query_embedding: queryEmbedding,
      match_count: 3,
    })
    if (memoryError) console.error('Memory retrieval error:', memoryError)

    let context = ''
    if (relevantChunks && relevantChunks.length > 0) {
      context = relevantChunks.map((c: any, i: number) => `[Document Source ${i + 1}]\n${c.content}`).join('\n\n---\n\n')
    }

    let memoriesContext = ''
    if (relevantMemories && relevantMemories.length > 0) {
      memoriesContext = relevantMemories.map((m: any, i: number) => `- ${m.content}`).join('\n')
    }

    let systemPrompt = `You are a helpful AI assistant. Answer the user's question based on your uploaded documents and your long-term learned memories.`
    
    if (context) {
      systemPrompt += `\n\nUploaded Knowledge Base Content:\n${context}`
    } else {
      systemPrompt += `\n\nNote: No matching document segments were found in the uploaded knowledge base files.`
    }

    if (memoriesContext) {
      systemPrompt += `\n\nLong-Term Learned Memories (Things you remember learning from past conversations with this user):\n${memoriesContext}`
    }

    systemPrompt += `\n\nFormat your responses using Markdown — use code blocks for code, headers for structure, bullet points for lists.`

    let historyMessages = messages || []
    if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === 'user') {
      historyMessages = historyMessages.slice(0, -1)
    }

    const formattedHistory: any[] = []
    let lastRole: string | null = null

    for (const m of historyMessages) {
      const currentRole = m.role === 'user' ? 'user' : 'assistant'
      
      if (currentRole === lastRole) {
        if (formattedHistory.length > 0) {
          formattedHistory[formattedHistory.length - 1].content += `\n\n${m.content}`
        }
      } else {
        formattedHistory.push({
          role: currentRole,
          content: m.content,
        })
        lastRole = currentRole
      }
    }

    while (formattedHistory.length > 0 && formattedHistory[0].role !== 'user') {
      formattedHistory.shift()
    }
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') {
      formattedHistory.pop()
    }

    const payloadMessages = [
      { role: 'system', content: systemPrompt },
      ...formattedHistory,
      { role: 'user', content: question }
    ]

    let activeStream: Response | null = null
    let workingModel = ''

    for (const modelName of FREE_MODELS) {
      try {
        const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://vercel.app',
            'X-Title': 'KB Chat',
          },
          body: JSON.stringify({
            model: modelName,
            messages: payloadMessages,
            stream: true,
          })
        })

        if (openRouterRes.ok) {
          activeStream = openRouterRes
          workingModel = modelName
          break
        } else {
          const errText = await openRouterRes.text()
          console.warn(`Model ${modelName} returned status ${openRouterRes.status}:`, errText)
        }
      } catch (err) {
        console.error(`Connection failed for model ${modelName}:`, err)
      }
    }

    if (!activeStream) {
      throw new Error('All free AI models on OpenRouter are currently busy or unavailable. Please try again in a few moments.')
    }

    const reader = activeStream.body!.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmedLine = line.trim()
              if (trimmedLine.startsWith('data: ')) {
                const data = trimmedLine.slice(6).trim()
                if (data === '[DONE]') break
                try {
                  const parsed = JSON.parse(data)
                  const text = parsed.choices?.[0]?.delta?.content
                  if (text) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
                  }
                } catch (e) {}
              }
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } catch (e) {
          controller.error(e)
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (err: any) {
    console.error('Chat error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
}
