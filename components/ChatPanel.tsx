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
}

export default function ChatPanel() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent])

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
        body: JSON.stringify({ messages: updatedMessages.slice(-10), question }),
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
              const text = parsed.choices?.[0]?.delta?.content
              if (text) {
                fullContent += parsed.text
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
              const text = parsed.choices?.[0]?.delta?.content
              if (text) {
                fullContent += parsed.text
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

  return (
    <div className="flex flex-1 h-screen overflow-hidden min-w-0">
      <div className="w-56 flex-shrink-0 bg-[#0b0e14] border-r border-white/5 flex flex-col h-full">
        <div className="p-3 border-b border-white/5 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-400">Conversations</span>
          <button
            onClick={createSession}
            className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            title="New Chat"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              className={`group flex items-center justify-between rounded-lg px-2.5 py-2 transition-all cursor-pointer text-xs
                ${activeSessionId === s.id ? 'bg-blue-600/20 text-blue-400 border border-blue-500/20' : 'text-gray-400 hover:bg-white/3 hover:text-white border border-transparent'}`}
            >
              <span className="truncate max-w-[140px] font-medium">{s.title}</span>
              <button
                onClick={(e) => deleteSession(s.id, e)}
                className="opacity-0 group-hover:opacity-100 hover:text-red-400 text-gray-600 transition-opacity p-0.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col h-full flex-1 bg-[#0f1219] min-w-0">
        <header className="flex items-center justify-between px-6 py-3.5 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-white">
              {sessions.find(s => s.id === activeSessionId)?.title || 'Knowledge Base Chat'}
            </h1>
            <span className="text-[11px] text-gray-500 bg-white/6 px-2 py-0.5 rounded-full">
              Gemini 2.5 Flash
            </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-8 pb-20">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-900/30">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div className="text-center">
                <h2 className="text-lg font-semibold text-white mb-2">Chat with your knowledge base</h2>
                <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
                  The AI learns dynamically from your documents and your messages.
                </p>
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-md shadow-blue-900/30">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                      </svg>
                    </div>
                  )}
                  <div className={`max-w-[85%] ${msg.role === 'user'
                    ? 'bg-blue-600/25 border border-blue-500/30 rounded-2xl rounded-tr-sm px-4 py-3'
                    : 'flex-1'
                  }`}>
                    {msg.role === 'user' ? (
                      <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <MarkdownRenderer content={msg.content} />
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                      </svg>
                    </div>
                  )}
                </div>
              ))}

              {streamingContent && (
                <div className="flex gap-3 justify-start">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-md shadow-blue-900/30">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                    </svg>
                  </div>
                  <div className="flex-1">
                    <MarkdownRenderer content={streamingContent} isStreaming />
                  </div>
                </div>
              )}

              {loading && !streamingContent && (
                <div className="flex gap-3 items-center">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-900/30">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                    </svg>
                  </div>
                  <div className="flex items-center gap-1.5 py-2">
                    {[0, 150, 300].map(delay => (
                      <span key={delay} className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                    ))}
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="flex-shrink-0 px-6 py-4 border-t border-white/8">
          <div className="max-w-3xl mx-auto">
            <div className={`flex items-end gap-3 bg-white/5 border rounded-2xl px-4 py-3 transition-colors
              ${loading ? 'border-white/8' : 'border-white/10 hover:border-white/15 focus-within:border-blue-500/60 focus-within:bg-white/7'}`}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => { setInput(e.target.value); adjustTextarea() }}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your knowledge base…"
                rows={1}
                disabled={loading}
                className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 resize-none outline-none leading-relaxed disabled:opacity-50"
                style={{ minHeight: '24px', maxHeight: '200px' }}
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all cursor-pointer
                  disabled:opacity-30 disabled:cursor-not-allowed
                  bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:bg-white/10"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </div>
            <p className="text-[10px] text-gray-700 text-center mt-2">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
