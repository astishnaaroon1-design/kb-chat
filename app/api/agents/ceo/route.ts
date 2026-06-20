import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'edge'

// Our prioritized fallback list of models
const FREE_MODELS = [
  { name: 'meta/llama-3.3-70b-instruct', provider: 'github' },
  { name: 'openai/gpt-4o', provider: 'github' },
  { name: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  { name: 'deepseek/deepseek-v4-flash:free', provider: 'openrouter' },
  { name: 'openrouter/free', provider: 'openrouter' }
]

export async function POST(req: NextRequest) {
  try {
    const { goal, sessionId } = await req.json()
    if (!goal) return NextResponse.json({ error: 'goal is required' }, { status: 400 })

    // 1. Fetch our active agent directory so the CEO knows who works in the company
    const { data: roster, error: rosterError } = await supabaseAdmin
      .from('agent_directory')
      .select('id, name, role, skills')
    if (rosterError) throw rosterError

    const rosterText = roster.map((r: any) => `- ID: ${r.id}, Role: ${r.role}, Skills: ${r.skills.join(', ')}`).join('\n')

    // 2. Instruct the CEO to analyze the goal and output a structured task breakdown
    const ceoSystemPrompt = `You are the AI Chief Executive Officer (CEO) of this quantitative trading journal SaaS.
    Your job is to read the user's high-level goal, analyze our active employee roster, and break the goal down into a logical sequence of individual tasks.

    Active Employee Roster:
    ${rosterText}

    Task Breakdown Rules:
    - Assign each task to the correct agent ID from the roster (e.g. 'designer_1' or 'coder_1').
    - Set up logical dependencies. If Task B requires Task A to be finished first, specify that Task B depends on Task A.
    - Output your entire response as a raw, valid JSON array of objects. Do not write any conversational intro or markdown formatting outside of the JSON.

    JSON Structure to Output:
    [
      {
        "id_label": "unique_label_1",
        "title": "Short Task Title",
        "description": "Detailed description of what this agent must do.",
        "assigned_to": "agent_id_from_roster",
        "depends_on_label": null
      },
      {
        "id_label": "unique_label_2",
        "title": "Short Task Title",
        "description": "Detailed description of what this agent must do.",
        "assigned_to": "agent_id_from_roster",
        "depends_on_label": "unique_label_1"
      }
    ]`

    let responseJson: any = null
    let success = false

    // Try our multi-provider fallback list
    for (const modelItem of FREE_MODELS) {
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
            messages: [
              { role: 'system', content: ceoSystemPrompt },
              { role: 'user', content: `Break down this goal: "${goal}"` }
            ],
            stream: false
          })
        })

        if (res.ok) {
          const rawData = await res.json()
          const rawText = rawData.choices?.[0]?.message?.content?.trim() || ''
          
          // Clean up potential markdown JSON code block wrappers
          const jsonText = rawText.replace(/^```json\s*/i, '').replace(/```$/, '').trim()
          responseJson = JSON.parse(jsonText)
          success = true
          break
        }
      } catch (err) {
        console.error(`CEO Model ${modelName} failed:`, err)
      }
    }

    if (!success || !Array.isArray(responseJson)) {
      throw new Error('CEO was unable to compile a valid task breakdown.')
    }

    // 3. Write tasks into Supabase while maintaining the database dependencies (Foreign Keys)
    const labelToUuidMap: Record<string, string> = {}

    // First Pass: Insert tasks that have no dependencies and generate their database UUIDs
    for (const t of responseJson) {
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

    // Second Pass: Link the tasks that have dependencies using our generated UUID map
    for (const t of responseJson) {
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

    return NextResponse.json({ success: true, tasks_created: responseJson.length })
  } catch (err: any) {
    console.error('CEO Agent error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
