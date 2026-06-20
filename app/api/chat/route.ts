import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

// We remain on Vercel's Edge Runtime to prevent any 10-second timeouts
export const runtime = 'edge'

// The master multi-provider fallback chain
const MODELS_CHAIN = [
  // Tier 1: Highest Priority - GitHub PAT Models
  { name: 'meta/llama-3.3-70b-instruct', provider: 'github' },
  { name: 'openai/gpt-4o', provider: 'github' },
  { name: 'openai/gpt-4o-mini', provider: 'github' },

  // Tier 2: Medium Priority - Elite Coding Models on OpenRouter
  { name: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  { name: 'deepseek/deepseek-v4-flash:free', provider: 'openrouter' },

  // Tier 3: Lowest Priority - OpenRouter Evergreen Free Router Backup
  { name: 'openrouter/free', provider: 'openrouter' }
]

export async function POST(req: NextRequest) {
  try {
    const { messages, question } = await req.json()
    if (!question) return new Response(JSON.stringify({ error: 'question required' }), { status: 400 })

    // 1. Generate embedding coordinates using Gemini
    const queryEmbedding = await embedText(question)

    // 2. Perform Hybrid Search on uploaded documents (chunks)
    const { data: relevantChunks, error: searchError } = await supabaseAdmin.rpc('match_chunks_hybrid', {
      query_embedding: queryEmbedding,
      query_text: question,
      match_count: 5,
      vector_weight: 0.6,
      fts_weight: 0.4
    })
    if (searchError) throw searchError

    // 3. Search your AI's learned memories
    const { data: relevantMemories, error: memoryError } = await supabaseAdmin.rpc('match_memories', {
      query_embedding: queryEmbedding,
      match_count: 3,
    })
    if (memoryError) console.error('Memory retrieval error:', memoryError)

    // 4. Assemble document context
    let context = ''
    if (relevantChunks && relevantChunks.length > 0) {
      context = relevantChunks.map((c: any, i: number) => `[Document Source ${i + 1}]\n${c.content}`).join('\n\n---\n\n')
    }

    // 5. Assemble learned memories context
    let memoriesContext = ''
    if (relevantMemories && relevantMemories.length > 0) {
      memoriesContext = relevantMemories.map((m: any, i: number) => `- ${m.content}`).join('\n')
    }

    // 6. Blend them into the AI system prompt (Senior Developer Persona)
    let systemPrompt = `You are "Suite Copilot", an expert quantitative software architect, elite programmer, and computer science mentor. Answer the user's question directly and comprehensively.
    
    CRITICAL REQUIREMENT: Before writing your actual answer, you MUST write down your step-by-step thinking process, analysis, and retrieval planning inside a <thinking>...</thinking> block.
    Keep your <thinking> block highly concise and brief (under 3-4 sentences) so that you get straight to writing your code and avoid lag.
    Once you close the </thinking> block, write your final response using your uploaded documents and memories.
    
    Example output structure:
    <thinking>
    I am analyzing the user's coding request... I will retrieve the preferred libraries...
    </thinking>
    Here is the complete, commented TypeScript code:
    \`\`\`typescript
    // code here
    \`\`\``
    
    if (context) {
      systemPrompt += `\n\nUploaded Knowledge Base Content:\n${context}`
    } else {
      systemPrompt += `\n\nNote: No matching document segments were found in the uploaded knowledge base files.`
    }

    if (memoriesContext) {
      systemPrompt += `\n\nLong-Term Learned Memories (Things you remember learning from past conversations with this user):\n${memoriesContext}`
    }

    systemPrompt += `\n\nFormat your responses using Markdown — use code blocks for code, headers for structure, bullet points for lists.`

    // 7. Format the chat history
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

    // Ensure history starts with user and alternates cleanly
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

    // 8. Iterate through our multi-provider fallback list until one succeeds
    let activeStream: Response | null = null
    let workingModel = ''
    let workingProvider = ''

    for (const modelItem of MODELS_CHAIN) {
      const { name: modelName, provider } = modelItem

      try {
        let endpoint = ''
        let authHeader = ''
        let payloadBody: any = {
          model: modelName,
          messages: payloadMessages,
          stream: true
        }

        if (provider === 'github') {
          // Skip if GitHub token is not configured on Vercel
          if (!process.env.GITHUB_TOKEN) {
            console.warn(`Skipping model ${modelName}: GITHUB_TOKEN is not configured on Vercel.`)
            continue
          }
          endpoint = 'https://models.github.ai/inference/chat/completions'
          authHeader = `Bearer ${process.env.GITHUB_TOKEN}`
        } else {
          // Skip if OpenRouter key is not configured on Vercel
          if (!process.env.OPENROUTER_API_KEY) {
            console.warn(`Skipping model ${modelName}: OPENROUTER_API_KEY is not configured on Vercel.`)
            continue
          }
          endpoint = 'https://openrouter.ai/api/v1/chat/completions'
          authHeader = `Bearer ${process.env.OPENROUTER_API_KEY}`
          payloadBody.temperature = 0.2 // OpenRouter optimization
        }

        console.log(`Connecting to ${provider} model: ${modelName}...`)
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
            ...(provider === 'openrouter' && {
              'HTTP-Referer': 'https://vercel.app',
              'X-Title': 'KB Chat'
            })
          },
          body: JSON.stringify(payloadBody)
        })

        if (res.ok) {
          const contentType = res.headers.get('content-type') || ''
          
          // Detect flat JSON error payloads returned as 200 OK
          if (contentType.includes('application/json')) {
            const json = await res.json()
            const errMsg = json.error?.message || json.message || 'JSON error response instead of stream'
            console.warn(`Model ${modelName} (${provider}) returned flat JSON error:`, errMsg)
            continue // Skip and try the next fallback!
          }

          activeStream = res
          workingModel = modelName
          workingProvider = provider
          console.log(`Success! Active model chosen: ${modelName} via ${provider}`)
          break // Found a working model, break the loop!
        } else {
          const errText = await res.text()
          console.warn(`Model ${modelName} (${provider}) returned status ${res.status}:`, errText)
        }
      } catch (err) {
        console.error(`Connection failed for ${provider} model ${modelName}:`, err)
      }
    }

    if (!activeStream) {
      throw new Error('All available models on GitHub and OpenRouter are currently busy or unavailable.')
    }

    // 9. Translate standard stream format into browser's expected format
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
                  
                  if (parsed.error) {
                    const errMsg = parsed.error.message || 'Stream error occurred'
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `\n\n[${workingProvider.toUpperCase()} Stream Error: ${errMsg}]\n\n` })}\n\n`))
                    break
                  }

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
