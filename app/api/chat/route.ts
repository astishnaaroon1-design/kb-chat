import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'edge'
export const maxDuration = 60

// 2026-Compliant Free Models List on OpenRouter
const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',  // 1. High-performance logic and coding model
  'deepseek/deepseek-v4-flash:free',         // 2. High-speed mixture-of-experts
  'openrouter/free',                         // 3. Evergreen Free Router backup
  'google/gemma-4-31b-it:free',              // 4. Google's Gemma 4 free model
  'openai/gpt-oss-120b:free'                 // 5. OpenAI gpt-oss-120b free model
]

export async function POST(req: NextRequest) {
  try {
    const { messages, question, sessionId } = await req.json()
    if (!question) return new Response(JSON.stringify({ error: 'question required' }), { status: 400 })

    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    // 1. Fetch current chat session details (checks for active stage & human gating)
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .single()

    const currentStage = session?.active_stage || 'idle'
    const isPendingApproval = session?.pending_approval || false

    // 2. Fetch our system documents (architecture_map.md)
    const { data: archDoc } = await supabaseAdmin
      .from('system_documents')
      .select('content')
      .eq('name', 'architecture_map.md')
      .single()
    const architectureMap = archDoc?.content || ''

    // 3. Fetch our active agent directory (roster)
    const { data: roster } = await supabaseAdmin
      .from('agent_directory')
      .select('id, name, role, skills')
    const rosterText = roster 
      ? roster.map((r: any) => `- ID: ${r.id}, Role: ${r.role}, Skills: ${r.skills.join(', ')}`).join('\n')
      : "No employees registered."

    // 4. Generate embedding coordinates using Gemini
    const queryEmbedding = await embedText(question)

    // 5. Perform Hybrid Search on uploaded documents
    const { data: relevantChunks, error: searchError } = await supabaseAdmin.rpc('match_chunks_hybrid', {
      query_embedding: queryEmbedding,
      query_text: question,
      match_count: 5,
      vector_weight: 0.6,
      fts_weight: 0.4
    })
    if (searchError) throw searchError

    let context = ''
    if (relevantChunks && relevantChunks.length > 0) {
      context = relevantChunks.map((c: any, i: number) => `[Document Source ${i + 1}]\n${c.content}`).join('\n\n---\n\n')
    }

    // 6. Build the CEO system prompt incorporating Interview and Stage Gate rules
    let systemPrompt = `You are "Suite Copilot", the AI Chief Executive Officer (CEO) of this workspace.
    You coordinate your team of specialized employees, manage the backlog, and converse naturally with the user.

    Active Employee Roster:
    ${rosterText}

    Current System Stage: "${currentStage}"
    Is Pending Human Approval: ${isPendingApproval ? 'YES' : 'NO'}

    System Architecture Map (Read this before planning anything):
    ${architectureMap}

    YOUR COGNITIVE LOGIC RULES:

    1. STAGE: "idle" (Starting a fresh project idea)
       - Analyze the user's prompt. Does it lack critical requirements (like what language to use, specific database tables, or layout styles)?
       - If details are missing:
         - Activate INTERVIEW MODE. 
         - Ask exactly ONE sharp, authentic clarifying question to get the missing detail.
         - Append this tool call at the end: [TOOL: set_interview_stage]
       - If requirements are completely clear:
         - Activate STAGE GATE. Create the task roadmap using our roster.
         - Append this tool call to freeze the pipeline and wait for approval: 
           [TOOL: create_roadmap [{"id_label": "t1", "title": "...", "description": "...", "assigned_to": "...", "depends_on_label": null}]]
         - Inform the user that the roadmap is ready and ask them to click "Approve & Deploy" to start.

    2. STAGE: "interview" (Currently asking clarifying questions)
       - Read the conversation history. Is the user's latest response sufficient?
       - If you still need more details, ask the next clarifying question. Do not call any tools.
       - If you now have enough details to proceed:
         - Compile the full roadmap.
         - Append the tool call: [TOOL: create_roadmap [{"id_label": "t1", "title": "...", "description": "...", "assigned_to": "...", "depends_on_label": null}]]
         - Inform the user that the roadmap is complete and ask them to click "Approve & Deploy" to start.

    3. STAGE: "gated" (Roadmap written, awaiting manual human approval)
       - Tell the user: "Your development roadmap is compiled and frozen. Please click 'Approve & Deploy' at the top of your screen to activate the team."
       - Do not call any tools.

    Format your response in clean Markdown. Append the [TOOL: ...] block exactly as specified at the very end of your response text if you trigger an action.`

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

    // 7. Try OpenRouter free models
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
            stream: true
          })
        })

        if (openRouterRes.ok) {
          const contentType = openRouterRes.headers.get('content-type') || ''
          if (contentType.includes('application/json')) {
            const json = await openRouterRes.json()
            console.warn(`Model ${modelName} returned flat JSON error:`, json)
            continue 
          }

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
      throw new Error('All free AI models on OpenRouter are currently busy or unavailable.')
    }

    // 8. Stream translation + tool execution
    const reader = activeStream.body!.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          let buffer = ''
          let fullContent = ''

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
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `\n\n[OpenRouter Stream Error: ${errMsg}]\n\n` })}\n\n`))
                    break
                  }

                  const text = parsed.choices?.[0]?.delta?.content
                  if (text) {
                    fullContent += text
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
                  }
                } catch (e) {}
              }
            }
          }

          // 9. Execute tools locally on the server after stream finishes
          let toolMatch = fullContent.match(/\[TOOL:\s*(\w+)(?:\s+({.*?|\[.*?\]))?\]/)
          if (toolMatch) {
            const toolName = toolMatch[1]
            let toolArgs: any = null
            try {
              if (toolMatch[2]) toolArgs = JSON.parse(toolMatch[2])
            } catch (pErr) {
              console.error('Tool args parse error:', pErr)
            }

            if (toolName === 'set_interview_stage') {
              console.log('CEO: Missing requirements. Entering Interview Mode.')
              await supabaseAdmin
                .from('chat_sessions')
                .update({ active_stage: 'interview' })
                .eq('id', sessionId)
            }

            if (toolName === 'create_roadmap' && Array.isArray(toolArgs)) {
              console.log('CEO: Complete requirements gathered. Creating frozen backlog roadmap...')
              const labelToUuidMap: Record<string, string> = {}

              // First Pass: Insert tasks
              for (const t of toolArgs) {
                const { data: createdTask, error: insertError } = await supabaseAdmin
                  .from('tasks')
                  .insert({
                    title: t.title,
                    description: t.description,
                    assigned_to: t.assigned_to,
                    status: 'pending'
                  })
                  .select()
                  .single()

                if (insertError) throw insertError
                labelToUuidMap[t.id_label] = createdTask.id
              }

              // Second Pass: Link dependencies
              for (const t of toolArgs) {
                if (t.depends_on_label && labelToUuidMap[t.depends_on_label]) {
                  const activeTaskId = labelToUuidMap[t.id_label]
                  const parentTaskUuid = labelToUuidMap[t.depends_on_label]

                  const { error: updateError } = await supabaseAdmin
                    .from('tasks')
                    .update({ dependency_id: parentTaskUuid })
                    .eq('id', activeTaskId)

                  if (updateError) throw updateError
                }
              }

              // Set session to GATED stage awaiting manual approval
              await supabaseAdmin
                .from('chat_sessions')
                .update({ 
                  active_stage: 'gated',
                  pending_approval: true 
                })
                .eq('id', sessionId)
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
