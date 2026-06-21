import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'edge'

// The prioritized fallback list of models
const FREE_MODELS = [
  { name: 'meta/llama-3.3-70b-instruct', provider: 'github' },
  { name: 'openai/gpt-4o', provider: 'github' },
  { name: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  { name: 'deepseek/deepseek-v4-flash:free', provider: 'openrouter' },
  { name: 'openrouter/free', provider: 'openrouter' }
]

export async function POST(req: NextRequest) {
  try {
    const { sessionId, actionType, taskId, errorMsg } = await req.json()
    if (!actionType) return NextResponse.json({ error: 'actionType is required' }, { status: 400 })

    // 1. Read the current architecture_map.md
    const { data: archDoc } = await supabaseAdmin
      .from('system_documents')
      .select('content')
      .eq('name', 'architecture_map.md')
      .single()

    const currentMap = archDoc?.content || ''

    // 2. Build the Auditor's System Prompt
    const auditorSystemPrompt = `You are the "AI Auditing & Knowledge Department" (The System Brain).
    Your job is to act as a cold, objective telemetry logger. You maintain a live document named "architecture_map.md" inside our database.
    
    Rules:
    - You must strictly output the updated, full-length content of "architecture_map.md" as raw markdown text. Do not include any conversational preambles, chat greetings, or formatting wrappers outside of the markdown document itself.
    - You must keep the document highly structured, professional, and dense to minimize token usage for future worker nodes.
    
    Current Content of "architecture_map.md":
    ${currentMap}`

    let userPrompt = ''

    if (actionType === 'task_completed' && taskId) {
      // Fetch the completed task details
      const { data: task } = await supabaseAdmin
        .from('tasks')
        .select('*')
        .eq('id', taskId)
        .single()

      if (!task) throw new Error('Task not found for auditing')

      userPrompt = `An agent has successfully completed a development task!
      Task: "${task.title}" (Assigned to: ${task.assigned_to})
      Deliverables/Output:
      ${task.result_content}

      Your Job:
      1. Update the "Current Project Status" section with the completed task details.
      2. Update the "Technical File Dependencies" section if any new files, dependencies, variables, or functions were designed/coded.
      3. Keep the historical learnings intact.`
    } else if (actionType === 'task_failed') {
      userPrompt = `A development task attempt has failed or thrown an error!
      Error Message/Context: "${errorMsg || 'Unknown compilation/runtime error'}"

      Your Job:
      1. Document this failure in the "Failure Log & Historical Learnings" section.
      2. Explicitly explain *why* the attempt failed, what bug occurred, and what the coder/tester must learn from this mistake to prevent it in the next iteration.`
    } else {
      return NextResponse.json({ success: true, message: 'No auditing actions required.' })
    }

    let updatedMap = ''
    let success = false

    // Try our multi-provider fallback list to complete the audit
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
              { role: 'system', content: auditorSystemPrompt },
              { role: 'user', content: userPrompt }
            ],
            stream: false
          })
        })

        if (res.ok) {
          const rawData = await res.json()
          updatedMap = rawData.choices?.[0]?.message?.content?.trim() || ''
          
          // Clean up potential markdown code block wrappers
          updatedMap = updatedMap.replace(/^```markdown\s*/i, '').replace(/```$/, '').trim()
          success = true
          break
        }
      } catch (err) {
        console.error(`Auditor Model ${modelName} failed:`, err)
      }
    }

    if (!success || !updatedMap) {
      throw new Error('Auditor was unable to compile the updated architecture map.')
    }

    // 3. Save the updated map back to Supabase
    const { error: saveError } = await supabaseAdmin
      .from('system_documents')
      .update({ content: updatedMap })
      .eq('name', 'architecture_map.md')

    if (saveError) throw saveError

    console.log(`Auditor: architecture_map.md updated successfully for action: ${actionType}`)
    return NextResponse.json({ success: true, message: 'Architecture map updated.' })
  } catch (err: any) {
    console.error('Auditor Agent error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}