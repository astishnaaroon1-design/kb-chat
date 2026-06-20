import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const runtime = 'edge'

export async function POST(req: NextRequest) {
  try {
    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    // 1. Fetch all active tasks in our backlog
    const { data: allTasks, error: fetchError } = await supabaseAdmin
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: true })

    if (fetchError) throw fetchError
    if (!allTasks || allTasks.length === 0) {
      return NextResponse.json({ success: true, message: 'No active tasks in backlog.' })
    }

    let triggeredCount = 0
    const completedTasks = allTasks.filter((t: any) => t.status === 'completed')
    const pendingTasks = allTasks.filter((t: any) => t.status === 'pending')

    // 2. Loop through pending tasks to see if they are ready to run
    for (const task of pendingTasks) {
      let isBlocked = false

      // Check if this task is waiting on a parent task
      if (task.dependency_id) {
        const parentTask = allTasks.find((t: any) => t.id === task.dependency_id)
        // If the parent task exists and is NOT completed, this task is blocked!
        if (parentTask && parentTask.status !== 'completed') {
          isBlocked = true
        }
      }

      // If the task is not blocked, let's start it!
      if (!isBlocked) {
        // Update its status in Supabase to 'in_progress'
        const { error: updateError } = await supabaseAdmin
          .from('tasks')
          .update({ status: 'in_progress' })
          .eq('id', task.id)

        if (updateError) throw updateError

        // Wake up the assigned employee agent by hitting their API route!
        const agentRoute = `/api/agents/${task.assigned_to}`
        console.log(`Supervisor: Triggering agent ${task.assigned_to} for task: "${task.title}"`)
        
        // We run this as an asynchronous background fetch so we don't block the Supervisor
        fetch(`${protocol}://${host}${agentRoute}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: task.id })
        }).catch(err => console.error(`Error invoking agent ${task.assigned_to}:`, err))

        triggeredCount++
      }
    }

    // 3. If ALL tasks are completed, let's deliver the final report to the user
    if (completedTasks.length === allTasks.length) {
      // Check if we already sent the delivery report to prevent double-posting
      const { data: lastMessages } = await supabaseAdmin
        .from('chat_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)

      const alreadyReported = lastMessages && lastMessages[0] && lastMessages[0].content.includes('## Project Delivery Report')

      if (!alreadyReported) {
        // Compile the outputs from all completed tasks
        let deliveryReport = `## Project Delivery Report 🚀\n\nYour AI development team has successfully completed all tasks!\n\n`
        
        for (const t of completedTasks) {
          deliveryReport += `### ✓ ${t.title} (Assigned to: ${t.assigned_to})\n`
          deliveryReport += `${t.result_content}\n\n---\n\n`
        }

        // Fetch your active chat session ID
        const { data: sessions } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .order('created_at', { ascending: false })
          .limit(1)

        if (sessions && sessions.length > 0) {
          // Write the beautiful delivery report straight into your chat
          await supabaseAdmin.from('chat_messages').insert({
            session_id: sessions[0].id,
            role: 'assistant',
            content: deliveryReport
          })
          
          // Clear the backlog to keep your workspace clean and ready for your next request
          await supabaseAdmin.from('tasks').delete().gt('created_at', '1970-01-01')
        }
      }
    }

    return NextResponse.json({ 
      success: true, 
      pending_tasks: pendingTasks.length, 
      tasks_triggered: triggeredCount 
    })
  } catch (err: any) {
    console.error('Supervisor Agent error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
      }
