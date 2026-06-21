import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { embedText } from '@/lib/gemini'

export const runtime = 'edge'

// The prioritized fallback list of models (Prioritizing high-speed GitHub PAT)
const FREE_MODELS = [
  { name: 'meta/llama-3.3-70b-instruct', provider: 'github' },
  { name: 'openai/gpt-4o', provider: 'github' },
  { name: 'meta-llama/llama-3.3-70b-instruct:free', provider: 'openrouter' },
  { name: 'deepseek/deepseek-v4-flash:free', provider: 'openrouter' },
  { name: 'openrouter/free', provider: 'openrouter' }
]

export async function POST(
  req: NextRequest,
  { params }: { params: { agentId: string } }
) {
  try {
    const { taskId } = await req.json()
    if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })

    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    // 1. Fetch the details of the active task
    const { data: task, error: taskError } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (taskError || !task) throw new Error('Task not found in backlog')

    // 2. Fetch the profile and skills of this specific active agent
    const { data: agent, error: agentError } = await supabaseAdmin
      .from('agent_directory')
      .select('*')
      .eq('id', params.agentId)
      .single()

    if (agentError || !agent) throw new Error(`Agent profile for ${params.agentId} not found`)

    // 3. Fetch the current system architecture_map.md to prevent token waste
    const { data: archDoc } = await supabaseAdmin
      .from('system_documents')
      .select('content')
      .eq('name', 'architecture_map.md')
      .single()
    const architectureMap = archDoc?.content || ''

    // 4. Check if there was prior work completed by a teammate that we must build upon
    let dependencyContext = ''
    if (task.dependency_id) {
      const { data: parentTask } = await supabaseAdmin
        .from('tasks')
        .select('*')
        .eq('id', task.dependency_id)
        .single()

      if (parentTask && parentTask.result_content) {
        dependencyContext = `Prior Work Completed by Teammate (${parentTask.assigned_to}):\n${parentTask.result_content}`
      }
    }

    // 5. Formulate the highly specialized developer instructions for this worker
    const employeePrompt = `You are "${agent.name}" working in the role of "${agent.role}".
    Your specialized skills are: ${agent.skills.join(', ')}.

    Current System Architecture Map (Review this to understand existing files, dependencies, and previous failure logs):
    ${architectureMap}

    You have been assigned this specific task:
    Task Title: "${task.title}"
    Task Description: "${task.description}"

    ${dependencyContext ? `Here is the prior work completed by your teammate that you must review and build directly upon:\n\n${dependencyContext}` : ''}

    Rules:
    - Output your deliverables with maximum professionalism and complete accuracy.
    - If you are a Designer, write clean Tailwind layouts and detailed wireframe specifications.
    - If you are a Software Engineer, write fully working, commented, production-grade Next.js React code blocks.
    - Do not include conversational greetings. Focus solely on producing the required file contents or specs.`

    let resultText = ''
    let success = false

    // Try our multi-provider fallback list to complete the task
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
            messages: [{ role: 'user', content: employeePrompt }],
            stream: false
          })
        })

        if (res.ok) {
          const rawData = await res.json()
          resultText = rawData.choices?.[0]?.message?.content?.trim() || ''
          success = true
          break
        }
      } catch (err) {
        console.error(`Employee Agent ${modelName} failed:`, err)
      }
    }

    if (!success || !resultText) {
      // 6. If the employee fails, notify the Auditor to log the failure telemetry!
      fetch(`${protocol}://${host}/api/agents/auditor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: 'task_failed',
          errorMsg: `Agent ${params.agentId} failed to generate deliverables for task: "${task.title}"`
        })
      }).catch(err => console.error('Error triggering auditor from failed employee:', err))

      throw new Error(`Employee agent ${params.agentId} was unable to complete the task.`)
    }

    // 7. Save the completed deliverables back into Supabase and mark the task completed
    const { error: updateError } = await supabaseAdmin
      .from('tasks')
      .update({
        status: 'completed',
        result_content: resultText
      })
      .eq('id', taskId)

    if (updateError) throw updateError

    console.log(`Employee: Task "${task.title}" completed by ${params.agentId}. Notifying Auditor & Supervisor...`)

    // 8. Trigger the Auditor Agent to record our new deliverables and update architecture_map.md
    fetch(`${protocol}://${host}/api/agents/auditor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'task_completed',
        taskId: taskId
      })
    }).catch(err => console.error('Error triggering auditor from completed employee:', err))

    // 9. Trigger the Supervisor Agent again to scan the backlog and unblock the next task!
    fetch(`${protocol}://${host}/api/agents/supervisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('Error triggering supervisor from employee:', err))

    return NextResponse.json({ success: true, message: `Task completed by ${params.agentId}` })
  } catch (err: any) {
    console.error(`Employee Agent ${params.agentId} error:`, err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}