import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'nodejs'

const FREE_MODELS = [
  'openrouter/free',
  'deepseek/deepseek-v4-flash:free',
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free'
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

    for (const modelName of FREE_MODELS) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://vercel.app',
            'X-Title': 'KB Chat',
          },
          body: JSON.stringify({
            model: modelName,
            messages: [{ role: 'user', content: memoryPrompt }],
          })
        })

        if (res.ok) {
          const data = await res.json()
          responseText = data.choices?.[0]?.message?.content?.trim() || ''
          success = true
          break
        }
      } catch (err) {
        console.error(`Learn error for model ${modelName}:`, err)
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
