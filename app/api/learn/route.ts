import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'nodejs'

const MODELS_CHAIN = [
  // Tier 1: Highest Priority - GitHub PAT Models
  { name: 'meta/llama-3.3-70b-instruct', provider: 'github' },
  { name: 'openai/gpt-4o', provider: 'github' },
  { name: 'openai/gpt-4o-mini', provider: 'github' },

  // Tier 2: Medium Priority - Elite Coding Models on OpenRouter
  { name: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  { name: 'deepseek/deepseek-v4-flash:free', provider: 'openrouter' }
]

export async function POST(req: NextRequest) {
  try {
    const { userMessage, assistantResponse } = await req.json()
    if (!userMessage || !assistantResponse) {
      return NextResponse.json({ error: 'Missing conversation context' }, { status: 400 })
    }

    const memoryPrompt = `
      Analyze the following exchange between a User and an AI Assistant.
      Extract any important, evergreen facts, lessons learned, user preferences, or useful information discussed that should be saved to the AI's long-term memory for future conversations.
      
      Rules:
      - Only extract facts that are actually beneficial and true.
      - Keep facts clear, concise, and written as self-contained sentences (e.g., "The user prefers dark system themes" or "The blueprint design uses a 12px grid layout").
      - If nothing of long-term value was discussed, respond with the single word "NONE". Do not write anything else.
      - Do not include conversational greetings.

      Exchange:
      User: "${userMessage}"
      AI: "${assistantResponse}"
    `

    let responseText = ''
    let success = false

    for (const modelItem of MODELS_CHAIN) {
      const { name: modelName, provider } = modelItem

      try {
        let endpoint = ''
        let authHeader = ''

        if (provider === 'github') {
          if (!process.env.GITHUB_TOKEN) continue
          endpoint = 'https://models.github.ai/inference/chat/completions'
          authHeader = `Bearer ${process.env.GITHUB_TOKEN}`
        } else {
          if (!process.env.OPENROUTER_API_KEY) continue
          endpoint = 'https://openrouter.ai/api/v1/chat/completions'
          authHeader = `Bearer ${process.env.OPENROUTER_API_KEY}`
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: memoryPrompt }],
            stream: false
          })
        })

        if (res.ok) {
          const data = await res.json()
          responseText = data.choices?.[0]?.message?.content?.trim() || ''
          success = true
          break
        }
      } catch (err) {
        console.error(`Learn error for ${provider} model ${modelName}:`, err)
      }
    }

    if (!success || responseText === 'NONE' || responseText.length < 5) {
      return NextResponse.json({ success: true, learned: 0 })
    }

    const lines = responseText
      .split('\n')
      .map(line => line.replace(/^[-*•\s]+/, '').trim())
      .filter(line => line.length > 10)

    let savedCount = 0
    for (const fact of lines) {
      const embedding = await embedText(fact)

      const { error } = await supabaseAdmin.from('memories').insert({
        content: fact,
        embedding,
      })

      if (!error) savedCount++
    }

    return NextResponse.json({ success: true, learned: savedCount })
  } catch (err: any) {
    console.error('Learning error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
                                 }
