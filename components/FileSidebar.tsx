'use client'

import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

interface UploadedFile {
  id: string
  name: string
  type: string
  size: number
  status: 'uploading' | 'indexing' | 'ready' | 'error'
  chunks?: number
  errorMsg?: string
}

export default function FileSidebar() {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const fetchExistingFiles = async () => {
      try {
        const { data, error } = await supabase
          .from('files')
          .select('*, chunks(count)')
          .order('created_at', { ascending: false })

        if (error) throw error

        if (data) {
          const loadedFiles: UploadedFile[] = data.map((f: any) => {
            const chunksCount = f.chunks?.[0]?.count || 0
            return {
              id: f.id,
              name: f.name,
              type: f.type,
              size: f.size || 0,
              status: 'ready',
              chunks: chunksCount,
            }
          })
          setFiles(loadedFiles)
        }
      } catch (err) {
        console.error('Error loading existing files:', err)
      }
    }

    fetchExistingFiles()
  }, [])

  const processFile = async (file: File) => {
    const tempId = Math.random().toString(36).slice(2)
    const newFile: UploadedFile = {
      id: tempId,
      name: file.name,
      type: file.type,
      size: file.size,
      status: 'uploading',
    }
    setFiles(prev => [newFile, ...prev])

    let currentId = tempId

    try {
      const formData = new FormData()
      formData.append('file', file)
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData })
      
      if (!uploadRes.ok) {
        const errorData = await uploadRes.json().catch(() => ({}))
        throw new Error(errorData.error || `Upload failed with status ${uploadRes.status}`)
      }

      const uploadData = await uploadRes.json()
      if (!uploadData.success) throw new Error(uploadData.error || 'Upload was unsuccessful')

      const fileId = uploadData.file.id
      setFiles(prev => prev.map(f => f.id === tempId
        ? { ...f, id: fileId, status: 'indexing' }
        : f
      ))
      currentId = fileId

      const indexRes = await fetch('/api/index-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })

      if (!indexRes.ok) {
        const errorData = await indexRes.json().catch(() => ({}))
        throw new Error(errorData.error || `Indexing failed with status ${indexRes.status}`)
      }

      const indexData = await indexRes.json()
      if (!indexData.success) throw new Error(indexData.error || 'Indexing was unsuccessful')

      setFiles(prev => prev.map(f => f.id === fileId
        ? { ...f, status: 'ready', chunks: indexData.chunks }
        : f
      ))
    } catch (err: any) {
      const errorMsg = err.message || 'An unexpected error occurred'
      setFiles(prev => prev.map(f => f.id === currentId
        ? { ...f, status: 'error', errorMsg }
        : f
      ))
    }
  }

  const handleSystemReset = async () => {
    const confirmReset = window.confirm(
      "Are you absolutely sure you want to perform a system factory reset? This will permanently delete all files in Supabase storage, all chat history threads, and all AI memories. This action cannot be undone."
    );
    if (!confirmReset) return;

    try {
      const res = await fetch('/api/system-reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        alert("System reset completed. Refreshing page...");
        window.location.reload();
      } else {
        throw new Error(data.error || "Wipe failed");
      }
    } catch (err: any) {
      alert(`Error resetting system: ${err.message}`);
    }
  }

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return
    Array.from(fileList).forEach(processFile)
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const fileIcon = (type: string) => {
    if (type.startsWith('image/')) return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    )
    if (type === 'text/csv') return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    )
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    )
  }

  const statusBadge = (file: UploadedFile) => {
    if (file.status === 'uploading') return (
      <span className="text-[10px] text-yellow-400 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />
        Uploading
      </span>
    )
    if (file.status === 'indexing') return (
      <span className="text-[10px] text-blue-400 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
        Indexing…
      </span>
    )
    if (file.status === 'ready') return (
      <span className="text-[10px] text-green-400 flex items-center gap-1">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        {file.chunks} chunk{file.chunks !== 1 ? 's' : ''} indexed
      </span>
    )
    return (
      <span className="text-[10px] text-red-400 block truncate max-w-[180px]" title={file.errorMsg}>
        Error: {file.errorMsg || 'Failed'}
      </span>
    )
  }

  return (
    <aside className="w-64 flex-shrink-0 bg-[#0d1117] border-r border-white/8 flex flex-col h-screen">
      <div className="p-4 border-b border-white/8">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-6 h-6 rounded-md bg-blue-600 flex items-center justify-center flex-shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-white">Knowledge Base</span>
        </div>
        <p className="text-[11px] text-gray-500 ml-8">Upload files to chat with</p>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        className={`mx-3 mt-3 rounded-xl border-2 border-dashed transition-all cursor-pointer p-4 flex flex-col items-center gap-2 text-center
          ${dragging ? 'border-blue-500 bg-blue-500/10' : 'border-white/10 hover:border-white/20 hover:bg-white/3'}`}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Drop files or <span className="text-blue-400">click to browse</span>
        </p>
        <p className="text-[10px] text-gray-600">TXT, CSV, PDF, DOCX, MD, Images</p>
        <input ref={inputRef} type="file" multiple className="hidden"
          accept=".txt,.csv,.pdf,.docx,.json,.png,.jpg,.jpeg,.webp,.md"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {files.length === 0 && (
          <p className="text-[11px] text-gray-600 text-center mt-4 leading-relaxed px-2">
            No files yet. Upload something to start chatting with your knowledge base.
          </p>
        )}
        {files.map(file => (
          <div key={file.id} className="flex items-start gap-2.5 rounded-lg p-2.5 bg-white/3 hover:bg-white/5 transition-colors">
            <span className={`mt-0.5 flex-shrink-0 ${
              file.status === 'ready' ? 'text-gray-400' :
              file.status === 'error' ? 'text-red-400' : 'text-gray-500'
            }`}>
              {fileIcon(file.type)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-gray-300 truncate font-medium">{file.name}</p>
              <p className="text-[10px] text-gray-600 mb-0.5">{formatSize(file.size)}</p>
              {statusBadge(file)}
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-white/8 space-y-2 flex flex-col items-center">
        <button
          onClick={handleSystemReset}
          className="w-full py-1.5 rounded-lg border border-red-500/30 hover:border-red-500 bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 text-[10px] font-medium transition-all cursor-pointer text-center"
        >
          Reset System (Wipe Everything)
        </button>
        <p className="text-[9px] text-gray-700 text-center">Powered by Gemini · Supabase · Vercel</p>
      </div>
    </aside>
  )
}
