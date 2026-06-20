import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'edge'

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
    const { messages, question } = await req.json()
    if (!question) return new Response(JSON.stringify({ error: 'question required' }), { status: 400 })

    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    // 1. Fetch our active agent directory so the CEO knows who works in the company
    const { data: roster } = await supabaseAdmin
      .from('agent_directory')
      .select('id, name, role, skills')
    const rosterText = roster 
      ? roster.map((r: any) => `- ID: ${r.id}, Role: ${r.role}, Skills: ${r.skills.join(', ')}`).join('\n')
      : "No employees registered."

    // 2. Fetch our current database backlog so the CEO can check progress
    const { data: activeTasks } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: true })

    const backlogText = activeTasks && activeTasks.length > 0
      ? activeTasks.map((t: any) => `- [${t.status.toUpperCase()}] ID: ${t.id}, Title: ${t.title}, Assigned to: ${t.assigned_to}, Depends on: ${t.dependency_id || 'None'}`).join('\n')
      : "The task backlog is currently empty. No active project is running."

    // 3. Generate embedding coordinates using Gemini (for lightweight semantic checks if needed)
    const queryEmbedding = await embedText(question)

    // 4. Formulate the conversational CEO Prompt
    let systemPrompt = `You are "Suite Copilot", the AI Chief Executive Officer (CEO) of this workspace. 
    Your job is to coordinate a team of specialized agents, manage the database task backlog, and communicate naturally with the user.

    Active Employee Roster:
    ${rosterText}

    Current Project Backlog:
    ${backlogText}

    YOUR COGNITIVE RULES:
    1. If the backlog is empty and the user gives a high-level goal:
       - Break the goal down into a logical sequence of tasks (e.g. design first, then coding).
       - Append this tool call at the very end of your response text:
         [TOOL: create_project [{"id_label": "t1", "title": "Task Title", "description": "Instructions", "assigned_to": "agent_id", "depends_on_label": null}]]
       - Reply to the user: "I have broken down your goal and assigned the tasks. The team is on its job! 🚀"

    2. If the user asks about progress or status (e.g., "how much is done?", "status?"):
       - Read the Current Project Backlog above.
       - Provide a warm, natural, and encouraging progress update telling the user exactly what is completed, what is active, and who is working on it.
       - Do not call any tools.

    3. If the user asks to do something new, and there is already an active project running:
       - Reply naturally asking them to clarify: "Is this a general question, or would you like me to add this as a new task inside our current active project?"
       - Do not call any tools.

    4. If the user replies "inside that project" or confirms they want to add a task to the active project:
       - Add the task to the backlog.
       - Append this tool call at the very end of your response text:
         [TOOL: add_task {"title": "Task Title", "description": "Instructions", "assigned_to": "agent_id"}]
       - Reply to the user: "Understood! I have added this new task to the current project. The team is on its job! 🚀"

    5. If the user is just chatting, asking general questions, or discussing design details:
       - Reply naturally and professionally. Do not call any tools.

    Format your response in clean Markdown. If you call a tool, append the command exactly as shown (e.g. [TOOL: ...]) at the very end of your response text.`

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

    // 5. Try each free model on OpenRouter until one succeeds
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

    // 6. Translate OpenRouter stream and execute background tools
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

          // 7. Parse and execute the tools directly on the server after streaming completes!
          let toolMatch = fullContent.match(/\[TOOL:\s*(\w+)(?:\s+({.*?|\[.*?\]))?\]/)
          if (toolMatch) {
            const toolName = toolMatch[1]
            let toolArgs: any = null
            try {
              if (toolMatch[2]) toolArgs = JSON.parse(toolMatch[2])
            } catch (pErr) {
              console.error('Tool args parse error:', pErr)
            }

            if (toolName === 'create_project' && Array.isArray(toolArgs)) {
              console.log('CEO: Creating new project backlog...')
              const labelToUuidMap: Record<string, string> = {}

              // First Pass: Insert tasks that have no dependencies and generate their database UUIDs
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

              // Second Pass: Link the tasks that have dependencies
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

              // Trigger Supervisor Agent to start the loop
              fetch(`${protocol}://${host}/api/agents/supervisor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              }).catch(err => console.error('Error triggering supervisor from CEO:', err))
            }

            if (toolName === 'add_task' && toolArgs) {
              console.log('CEO: Appending new task to current project backlog...')
              const { error: insertError } = await supabaseAdmin
                .from('tasks')
                .insert({
                  title: toolArgs.title,
                  description: toolArgs.description,
                  assigned_to: toolArgs.assigned_to,
                  status: 'pending'
                })

              if (insertError) throw insertError

              // Trigger Supervisor Agent
              fetch(`${protocol}://${host}/api/agents/supervisor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              }).catch(err => console.error('Error triggering supervisor from CEO:', err))
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
