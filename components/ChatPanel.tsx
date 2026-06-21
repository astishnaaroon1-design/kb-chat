'use client'

import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import MarkdownRenderer from './MarkdownRenderer'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatSession {
  id: string
  title: string
  created_at: string
  pending_approval: boolean
  active_stage: string
}

interface Task {
  id: string
  title: string
  description: string
  assigned_to: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  dependency_id: string | null
}

// 1. Specialized helper to separate and parse thoughts from the text stream
function parseThinkingAndContent(text: string) {
  const thinkingRegex = /<thinking>([\s\S]*?)(?:<\/thinking>|$)/i
  const match = text.match(thinkingRegex)
  
  let thinking = ""
  let content = text
  let isThinkingComplete = false

  if (match) {
    thinking = match[1]
    content = text.replace(thinkingRegex, "").trim()
    if (text.toLowerCase().includes("</thinking>")) {
      isThinkingComplete = true
    }
  }

  // Trim out any [TOOL: ...] block so the user only sees clean conversation
  content = content.replace(/\[TOOL:\s*.*\]/g, '').trim()
  
  return { thinking, content, isThinkingComplete }
}

// UI component for individual chat messages
function MessageItem({ msg, isStreaming }: { msg: Message; isStreaming?: boolean }) {
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(true)
  const { thinking, content, isThinkingComplete } = parseThinkingAndContent(msg.content)

  return (
    <div className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      {msg.role === 'assistant' && (
        <div className="w-7 h-7 rounded-lg bg-[#0c1322] border border-cyan-500/30 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-[0_0_8px_rgba(6,182,212,0.2)]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth="2.5">
            <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
            <line x1="12" y1="2" x2="12" y2="22"/>
            <line x1="2" y1="8.5" x2="22" y2="15.5"/>
            <line x1="2" y1="15.5" x2="22" y2="8.5"/>
          </svg>
        </div>
      )}
      <div className={`max-w-[85%] ${msg.role === 'user'
        ? 'bg-cyan-500/10 border border-cyan-500/20 rounded-2xl rounded-tr-sm px-4 py-3 shadow-[0_0_10px_rgba(6,182,212,0.05)] text-cyan-100'
        : 'flex-1 space-y-3'
      }`}>
        {msg.role === 'user' ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <>
            {/* Collapsible Thoughts Drawer */}
            {thinking && (
              <div className="border border-cyan-500/15 rounded-xl overflow-hidden bg-[#070b14] shadow-[0_0_8px_rgba(6,182,212,0.05)]">
                <button
                  onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                  className="w-full px-4 py-2.5 flex items-center justify-between text-[11px] font-mono tracking-wider text-cyan-400/70 hover:text-cyan-300 bg-[#0c1220]/80 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    {isStreaming && !isThinkingComplete ? (
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping inline-block" />
                    ) : (
                      <span className="text-cyan-500 font-bold">::</span>
                    )}
                    COGNITIVE_PROCESS_LOG
                  </span>
                  <span>{isThinkingExpanded ? '[-] CLOSE' : '[+] OPEN'}</span>
                </button>
                {isThinkingExpanded && (
                  <div className="p-3 text-xs text-cyan-500/70 font-mono leading-relaxed border-t border-cyan-500/10 bg-[#05070e] whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {thinking}
                  </div>
                )}
              </div>
            )}
            {/* Final Markdown Answer */}
            {content && (
              <div className="text-gray-100 bg-[#0c1220]/40 p-4 border border-white/5 rounded-2xl">
                <MarkdownRenderer 
                  content={content} 
                  isStreaming={isStreaming && isThinkingComplete} 
                />
              </div>
            )}
          </>
        )}
      </div>
      {msg.role === 'user' && (
        <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
      )}
    </div>
  )
}

export default function ChatPanel() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [approving, setApproveLoading] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

  // Fetch chat sessions on load
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const { data, error } = await supabase
          .from('chat_sessions')
          .select('*')
          .order('created_at', { ascending: false })

        if (error) throw error

        if (data && data.length > 0) {
          setSessions(data)
          setActiveSessionId(data[0].id)
        } else {
          createSession()
        }
      } catch (err) {
        console.error('Error fetching chat sessions:', err)
      }
    }

    fetchSessions()
  }, [])

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) return

    const fetchMessages = async () => {
      try {
        const { data, error } = await supabase
          .from('chat_messages')
          .select('*')
          .eq('session_id', activeSessionId)
          .order('created_at', { ascending: true })

        if (error) throw error

        if (data) {
          setMessages(data.map((m: any) => ({ role: m.role, content: m.content })))
        }
      } catch (err) {
        console.error('Error fetching messages:', err)
      }
    }

    fetchMessages()
  }, [activeSessionId])

  // Live Agent Backlog Telemetry - Polls Supabase every 2 seconds
  useEffect(() => {
    let intervalId: any

    const fetchActiveBacklog = async () => {
      try {
        const { data, error } = await supabase
          .from('tasks')
          .select('*')
          .order('created_at', { ascending: true })

        if (error) throw error
        if (data) {
          setTasks(data)
        }
      } catch (err) {
        console.error('Backlog fetch failed:', err)
      }
    }

    fetchActiveBacklog()
    intervalId = setInterval(fetchActiveBacklog, 2000)

    return () => clearInterval(intervalId)
  }, [])

  const createSession = async () => {
    try {
      const { data, error } = await supabase
        .from('chat_sessions')
        .insert({ title: 'New Chat' })
        .select()
        .single()

      if (error) throw error

      if (data) {
        setSessions(prev => [data, ...prev])
        setActiveSessionId(data.id)
        setMessages([])
      }
    } catch (err) {
      console.error('Error creating chat session:', err)
    }
  }

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const { error } = await supabase.from('chat_sessions').delete().eq('id', id)
      if (error) throw error

      const updatedSessions = sessions.filter(s => s.id !== id)
      setSessions(updatedSessions)

      if (activeSessionId === id) {
        if (updatedSessions.length > 0) {
          setActiveSessionId(updatedSessions[0].id)
        } else {
          createSession()
        }
      }
    } catch (err) {
      console.error('Error deleting chat session:', err)
    }
  }

  const handleManualApproval = async () => {
    if (!activeSessionId || approving) return
    setApproveLoading(true)
    try {
      const res = await fetch('/api/system-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      })

      if (res.ok) {
        setSessions(prev => prev.map(s => s.id === activeSessionId 
          ? { ...s, pending_approval: false, active_stage: 'running' } 
          : s
        ))
      } else {
        throw new Error('Approval request failed')
      }
    } catch (err: any) {
      alert(`System Activation Error: ${err.message}`)
    } finally {
      setApproveLoading(false)
    }
  }

  const adjustTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const sendMessage = async () => {
    const question = input.trim()
    if (!question || loading || !activeSessionId) return

    const userMessage: Message = { role: 'user', content: question }
    const updatedMessages = [...messages, userMessage]

    setMessages(updatedMessages)
    setInput('')
    setStreamingContent('')
    setLoading(true)

    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    try {
      await supabase.from('chat_messages').insert({
        session_id: activeSessionId,
        role: 'user',
        content: question,
      })

      const activeSession = sessions.find(s => s.id === activeSessionId)
      if (activeSession && activeSession.title === 'New Chat') {
        const shortenedTitle = question.length > 25 ? question.slice(0, 22) + '...' : question
        await supabase
          .from('chat_sessions')
          .update({ title: shortenedTitle })
          .eq('id', activeSessionId)

        setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, title: shortenedTitle } : s))
      }

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedMessages.slice(-10), question, sessionId: activeSessionId }),
      })

      if (!res.ok) throw new Error('Request failed')

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''
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
              const text = parsed.text
              if (text) {
                fullContent += text
                setStreamingContent(fullContent)
              }
            } catch (e) {}
          }
        }
      }

      if (buffer) {
        const trimmedLine = buffer.trim()
        if (trimmedLine.startsWith('data: ')) {
          const data = trimmedLine.slice(6).trim()
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data)
              const text = parsed.text
              if (text) {
                fullContent += text
                setStreamingContent(fullContent)
              }
            } catch (e) {}
          }
        }
      }

      setMessages(prev => [...prev, { role: 'assistant', content: fullContent }])
      setStreamingContent('')

      await supabase.from('chat_messages').insert({
        session_id: activeSessionId,
        role: 'assistant',
        content: fullContent,
      })

      const { data: updatedSession } = await supabase
        .from('chat_sessions')
        .select('*')
        .eq('id', activeSessionId)
        .single()

      if (updatedSession) {
        setSessions(prev => prev.map(s => s.id === activeSessionId ? updatedSession : s))
      }

      fetch('/api/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: question, assistantResponse: fullContent }),
      }).catch(err => console.error('Background learning error:', err))

    } catch (err) {
      const errorMsg = 'Sorry, something went wrong. Please try again.'
      setMessages(prev => [...prev, { role: 'assistant', content: errorMsg }])
      setStreamingContent('')

      await supabase.from('chat_messages').insert({
        session_id: activeSessionId,
        role: 'assistant',
        content: errorMsg,
      })
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const isEmpty = messages.length === 0 && !streamingContent
  const currentSession = sessions.find(s => s.id === activeSessionId)
  const isGated = currentSession?.pending_approval || false

  return (
    <div className="flex flex-1 h-screen overflow-hidden min-w-0 hud-scanline bg-[#030611] text-cyan-100 font-mono select-none">
      {/* 1. Left Sidebar (Threads List) */}
      <div className="w-56 flex-shrink-0 bg-[#060914]/95 border-r border-cyan-500/15 flex flex-col h-full shadow-[5px_0_15px_rgba(6,182,212,0.03)] z-10">
        <div className="p-3 border-b border-cyan-500/15 flex items-center justify-between bg-[#080d1e]/50">
          <span className="text-[10px] font-bold tracking-widest text-cyan-400">ACTIVE_THREADS</span>
          <button
            onClick={createSession}
            className="p-1 rounded border border-cyan-500/20 text-cyan-500 hover:text-white hover:bg-cyan-500/10 transition-colors cursor-pointer"
            title="Create Thread"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className={`group flex items-center justify-between rounded-lg px-2.5 py-2 transition-all cursor-pointer text-[11px] border
                ${activeSessionId === s.id 
                  ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-[0_0_8px_rgba(6,182,212,0.1)]' 
                  : 'text-cyan-500/50 hover:bg-cyan-500/5 hover:text-cyan-300 border-transparent'}`}
            >
              <span className="truncate max-w-[130px]">{s.title.toUpperCase()}</span>
              <button
                onClick={(e) => deleteSession(s.id, e)}
                className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-cyan-500/30 transition-opacity p-0.5"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Main Chat Panel with Shaded Grid */}
      <div className="flex flex-col h-full flex-1 bg-[#030611] min-w-0 relative hud-grid">
        
        {/* Glowing Gated Warning Banner (CEO Stage Gate) */}
        {isGated && (
          <div className="absolute top-0 left-0 right-0 bg-yellow-500/10 border-b border-yellow-500/30 p-3 flex items-center justify-between z-20 backdrop-blur-md animate-pulse">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-ping" />
              <span className="text-[10px] font-bold text-yellow-400 tracking-wider">
                STAGE_GATE_LOCKED: PIPELINE FROZEN AWAITING MANUAL DEPLOY
              </span>
            </div>
            <button
              onClick={handleManualApproval}
              disabled={approving}
              className="px-4 py-1 rounded-lg border border-red-500/30 hover:border-red-500 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 text-[10px] font-medium transition-all cursor-pointer text-center"
            >
              Reset System (Wipe Everything)
            </button>
          </div>
        )}

        <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-white">
              {sessions.find(s => s.id === activeSessionId)?.title || 'JARVIS_WORKSPACE'}
            </h1>
            <span className="text-[11px] text-gray-500 bg-white/6 px-2 py-0.5 rounded-full">
              Gemini 2.5 Flash
            </span>
          </div>
        </header>

        {/* Messages and Visual core */}
        <div className="flex-1 overflow-y-auto">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full gap-8 px-8 pb-10">
              
              {/* Rotating Holographic SVG Core Reactor (Holographic Brain) */}
              <div className="relative w-64 h-64 flex items-center justify-center">
                {/* Background Rotating Rings */}
                <svg className="absolute w-full h-full animate-spin" style={{ animationDuration: '20s' }} viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="48" fill="none" stroke="#06b6d4" strokeWidth="0.25" strokeDasharray="3,12" opacity="0.3"/>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="#0891b2" strokeWidth="0.5" strokeDasharray="20,10,5,10" opacity="0.5"/>
                </svg>
                <svg className="absolute w-[80%] h-[80%] animate-spin" style={{ animationDuration: '10s', animationDirection: 'reverse' }} viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="#f97316" strokeWidth="0.5" strokeDasharray="5,15" opacity="0.3"/>
                  <circle cx="50" cy="50" r="35" fill="none" stroke="#22d3ee" strokeWidth="1" strokeDasharray="40,5,10,5" opacity="0.5"/>
                </svg>

                {/* Connected Neural Node Lines and Nodes */}
                <svg className="absolute w-[90%] h-[90%] opacity-85" viewBox="0 0 120 120">
                  {/* Connection Lines */}
                  <line x1="60" y1="20" x2="60" y2="100" stroke="#06b6d4" strokeWidth="0.3" strokeDasharray="2,2"/>
                  <line x1="20" y1="60" x2="100" y2="60" stroke="#06b6d4" strokeWidth="0.3" strokeDasharray="2,2"/>
                  <line x1="30" y1="30" x2="90" y2="90" stroke="#f97316" strokeWidth="0.3" strokeDasharray="1,1"/>
                  <line x1="30" y1="90" x2="90" y2="30" stroke="#0891b2" strokeWidth="0.3" strokeDasharray="1,1"/>

                  {/* Brain Region Nodes with glowing colors */}
                  <circle cx="60" cy="20" r="3" fill="#ef4444" className="animate-pulse"/>
                  <circle cx="95" cy="35" r="2.5" fill="#f97316"/>
                  <circle cx="100" cy="60" r="3" fill="#3b82f6" className="animate-pulse"/>
                  <circle cx="20" cy="60" r="2.5" fill="#eab308"/>
                  <circle cx="60" cy="100" r="3" fill="#22c55e" className="animate-pulse"/>
                  <circle cx="85" cy="85" r="2" fill="#14b8a6"/>
                </svg>

                {/* Region Monospace Floating Labels */}
                <div className="absolute top-2 text-[8px] font-bold text-red-500 bg-red-950/40 border border-red-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(239,68,68,0.2)]">
                  PREFRONTAL
                </div>
                <div className="absolute top-12 right-2 text-[8px] font-bold text-orange-500 bg-orange-950/40 border border-orange-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(249,115,22,0.2)]">
                  MOTOR_CORTEX
                </div>
                <div className="absolute right-0 top-24 text-[8px] font-bold text-blue-500 bg-blue-950/40 border border-blue-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(59,130,246,0.2)]">
                  SENSORY_CORTEX
                </div>
                <div className="absolute left-0 top-24 text-[8px] font-bold text-yellow-500 bg-yellow-950/40 border border-yellow-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(234,179,8,0.2)]">
                  CONCEPT_LAYER
                </div>
                <div className="absolute bottom-6 text-[8px] font-bold text-green-500 bg-green-950/40 border border-green-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(34,197,94,0.2)]">
                  HIPPOCAMPUS
                </div>
                <div className="absolute bottom-12 right-4 text-[8px] font-bold text-teal-500 bg-teal-950/40 border border-teal-500/20 px-1.5 py-0.2 rounded font-mono shadow-[0_0_5px_rgba(20,184,166,0.2)]">
                  BRAINSTEM
                </div>

                {/* Central Pulsing Holographic Sphere */}
                <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-cyan-500/10 to-blue-500/20 border border-cyan-400/50 flex items-center justify-center shadow-[0_0_40px_rgba(6,182,212,0.4)] animate-pulse">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                    <polyline points="2 17 12 22 22 17"/>
                  </svg>
                </div>
              </div>

              <div className="text-center max-w-sm">
                <h2 className="text-sm font-bold text-cyan-400 tracking-widest uppercase mb-1.5">JARVIS COGNITIVE CORE V1</h2>
                <p className="text-[11px] text-cyan-500/70 leading-relaxed font-mono">
                  DIRECTIVES: Input project specifications. The CEO Agent will parse instructions and deploy holographic workspaces.
                </p>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
              {messages.map((msg, i) => (
                <MessageItem key={i} msg={msg} />
              ))}

              {streamingContent && (
                <MessageItem msg={{ role: 'assistant', content: streamingContent }} isStreaming />
              )}

              {/* Minimal Shimmering Google-style Loading Line */}
              {loading && !streamingContent && (
                <div className="flex gap-3 items-start">
                  <div className="w-7 h-7 rounded-lg bg-[#0c1322] border border-cyan-500/30 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-[0_0_8px_rgba(6,182,212,0.2)]">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth="2.5">
                      <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
                    </svg>
                  </div>
                  <div className="flex-1 pt-3.5">
                    <div className="relative w-full h-1 bg-cyan-950/40 rounded-full overflow-hidden border border-cyan-500/10">
                      <div className="absolute top-0 left-0 h-full w-1/3 rounded-full bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500" 
                           style={{ animation: 'shimmer-slide 1.5s infinite linear' }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-cyan-500/15 bg-[#060914]/50 backdrop-blur-md">
          <div className="max-w-3xl mx-auto">
            <div className={`flex items-end gap-3 bg-[#080d1d]/60 border rounded-2xl px-4 py-3 transition-colors
              ${loading ? 'border-cyan-500/10' : 'border-cyan-500/15 hover:border-cyan-500/30 focus-within:border-cyan-500/60 focus-within:bg-[#090f22]/80 focus-within:shadow-[0_0_15px_rgba(6,182,212,0.05)]'}`}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => { setInput(e.target.value); adjustTextarea() }}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your knowledge base, or discuss backlog status with your CEO..."
                rows={1}
                disabled={loading}
                className="flex-1 bg-transparent text-sm text-cyan-100 placeholder-cyan-500/30 resize-none outline-none leading-relaxed disabled:opacity-50 font-mono"
                style={{ minHeight: '24px', maxHeight: '200px' }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all cursor-pointer
                  disabled:opacity-30 disabled:cursor-not-allowed
                  bg-cyan-600 hover:bg-cyan-500 active:scale-95 disabled:bg-cyan-950/20 border border-cyan-500/30"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </div>
            <p className="text-[10px] text-cyan-500/40 text-center mt-2 tracking-wide">
              ENTER_TO_TRANSMIT · SHIFT+ENTER_NEW_LINE
            </p>
          </div>
        </div>
      </div>

      {/* 3. Holographic Agent Telemetry & Checklist (Right Column) */}
      <div className="w-64 flex-shrink-0 bg-[#060914]/95 border-l border-cyan-500/15 flex flex-col h-full shadow-[-5px_0_15px_rgba(6,182,212,0.03)] z-10">
        <div className="p-3 border-b border-cyan-500/15 bg-[#080d1e]/50 flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-widest text-cyan-400">AGENT_TELEMETRY</span>
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          
          {/* Work Status Card */}
          <div className="border border-cyan-500/15 rounded-xl p-3 bg-[#080d1e]/40 shadow-[0_0_10px_rgba(6,182,212,0.02)]">
            <span className="text-[9px] font-bold text-cyan-500/50 block tracking-widest mb-2.5">WORKSPACE_STATUS</span>
            {tasks.length === 0 ? (
              <div className="space-y-1.5">
                <div className="text-xs text-cyan-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                  STATUS: IDLE
                </div>
                <p className="text-[10px] text-cyan-500/50 leading-relaxed">
                  Awaiting ingestion directives. Submit a goal to initialize the backlog pipeline.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-yellow-400 flex items-center gap-1.5 animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block" />
                  STATUS: PROCESSING
                </div>
                <div className="text-[10px] text-cyan-500/70 leading-relaxed font-mono">
                  - Total Tasks: {tasks.length} <br />
                  - Completed: {tasks.filter(t => t.status === 'completed').length} <br />
                  - Active: {tasks.filter(t => t.status === 'in_progress').length}
                </div>
              </div>
            )}
          </div>

          {/* Floating Live Checklist */}
          {tasks.length > 0 && (
            <div className="space-y-2.5">
              <span className="text-[9px] font-bold text-cyan-500/50 block tracking-widest">TASK_MATRIX_LOG</span>
              <div className="space-y-2">
                {tasks.map(t => (
                  <div key={t.id} className="border border-cyan-500/10 rounded-lg p-2.5 bg-[#080d1e]/20 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-cyan-200 truncate max-w-[130px]" title={t.title}>
                        {t.title.toUpperCase()}
                      </span>
                      {/* State Badges */}
                      {t.status === 'completed' && (
                        <span className="text-[9px] text-green-400 border border-green-500/30 px-1.5 py-0.2 rounded bg-green-500/5">
                          DONE
                        </span>
                      )}
                      {t.status === 'in_progress' && (
                        <span className="text-[9px] text-cyan-400 border border-cyan-500/30 px-1.5 py-0.2 rounded bg-cyan-500/5 animate-pulse">
                          RUNNING
                        </span>
                      )}
                      {t.status === 'pending' && (
                        <span className="text-[9px] text-cyan-500/30 border border-cyan-500/10 px-1.5 py-0.2 rounded bg-white/2">
                          GATED
                        </span>
                      )}
                    </div>
                    <p className="text-[9px] text-cyan-500/60 leading-normal line-clamp-2">
                      {t.description}
                    </p>
                    <div className="text-[9px] text-cyan-500/40 font-bold tracking-wider">
                      AGENT: {t.assigned_to.toUpperCase()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="p-3 border-t border-cyan-500/15 bg-[#080d1e]/50 text-center">
          <p className="text-[8px] text-cyan-500/30 tracking-widest">
            COGNITIVE_GRID_ESTABLISHED
          </p>
        </div>
      </div>

      {/* Global Sci-Fi CSS Overlays */}
      <style jsx global>{`
        .hud-grid {
          background-size: 30px 30px;
          background-image: 
            linear-gradient(to right, rgba(6, 182, 212, 0.02) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(6, 182, 212, 0.02) 1px, transparent 1px);
        }
        .hud-scanline {
          position: relative;
          overflow: hidden;
        }
        .hud-scanline::after {
          content: " ";
          display: block;
          position: absolute;
          top: 0; left: 0; bottom: 0; right: 0;
          background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.15) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03));
          z-index: 2;
          background-size: 100% 2px, 3px 100%;
          pointer-events: none;
        }
        @keyframes shimmer-slide {
          0% { left: -30%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  )
}