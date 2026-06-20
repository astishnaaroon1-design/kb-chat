import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'nodejs'
export const maxDuration = 60

// 2026-Compliant Free Models List on OpenRouter
const FREE_MODELS = [
  'openrouter/free',                         // 1. Evergreen Free Router (dynamically picks available models)
  'deepseek/deepseek-v4-flash:free',         // 2. High-speed mixture-of-experts
  'google/gemma-4-31b-it:free',              // 3. Google's Gemma 4 free model
  'meta-llama/llama-3.3-70b-instruct:free',  // 4. Llama 3.3 70B multilingual free model
  'openai/gpt-oss-120b:free'                 // 5. OpenAI gpt-oss-120b free model
]

export async function POST(req: NextRequest) {
  try {
    const { messages, question } = await req.json()
    if (!question) return NextResponse.json({ error: 'question required' }, { status: 400 })

    // 1. Generate embedding coordinates using Gemini (free and high-limit)
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

    // 6. Blend them both into the AI system prompt
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

    // 8. Try each free model on OpenRouter until one succeeds (Non-Streaming!)
    let responseJson: any = null
    let workingModel = ''

    for (const modelName of FREE_MODELS) {
      try {
        console.log(`Connecting to: ${modelName}...`)
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
            temperature: 0.2,
            stream: false // Non-streaming
          })
        })

        if (openRouterRes.ok) {
          responseJson = await openRouterRes.json()
          workingModel = modelName
          console.log(`Success! Active model chosen: ${modelName}`)
          break
        } else {
          const errText = await openRouterRes.text()
          console.warn(`Model ${modelName} returned status ${openRouterRes.status}:`, errText)
        }
      } catch (err) {
        console.error(`Connection failed for model ${modelName}:`, err)
      }
    }

    if (!responseJson) {
      throw new Error('All free AI models on OpenRouter are currently busy or unavailable. Please try again in a few moments.')
    }

    // 9. Extract final clean output text
    const finalCleanOutput = responseJson.choices?.[0]?.message?.content || "I was unable to analyze that request."

    return NextResponse.json({ text: finalCleanOutput })

  } catch (err: any) {
    console.error('Chat error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
