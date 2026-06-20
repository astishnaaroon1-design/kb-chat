'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useState } from 'react'

interface MarkdownProps {
  content: string
  isStreaming?: boolean
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors px-2 py-1 rounded hover:bg-white/10">
      {copied ? <>✓ Copied</> : <>Copy</>}
    </button>
  )
}

export default function MarkdownRenderer({ content, isStreaming }: MarkdownProps) {
  return (
    <div className="prose prose-invert max-w-none text-[15px] leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }: any) {
            const inline = !className
            const match = /language-(\w+)/.exec(className || '')
            const language = match ? match[1] : ''
            const codeString = String(children).replace(/\n$/, '')
            if (inline) {
              return <code className="bg-[#1e2433] text-[#e2e8f0] text-[13px] px-1.5 py-0.5 rounded font-mono" {...props}>{children}</code>
            }
            return (
              <div className="my-4 rounded-xl overflow-hidden border border-white/10 shadow-lg">
                <div className="flex items-center justify-between bg-[#1a1f2e] px-4 py-2.5 border-b border-white/10">
                  <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">{language || 'code'}</span>
                  <CopyButton code={codeString} />
                </div>
                <SyntaxHighlighter
                  style={oneDark} language={language || 'text'} PreTag="div"
                  customStyle={{ margin: 0, padding: '1.25rem 1rem', background: '#0d1117', fontSize: '13.5px', lineHeight: '1.7', borderRadius: 0 }}
                  codeTagProps={{ style: { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" } }}
                >{codeString}</SyntaxHighlighter>
              </div>
            )
          },
          h1: ({ children }) => <h1 className="text-xl font-semibold text-white mt-6 mb-3">{children}</h1>,
          h2: ({ children }) => <h2 className="text-lg font-semibold text-white mt-5 mb-2.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-base font-semibold text-gray-200 mt-4 mb-2">{children}</h3>,
          p: ({ children }) => <p className="text-gray-200 leading-7 mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="text-gray-200 pl-5 mb-3 space-y-1.5 list-disc marker:text-gray-500">{children}</ul>,
          ol: ({ children }) => <ol className="text-gray-200 pl-5 mb-3 space-y-1.5 list-decimal marker:text-gray-500">{children}</ol>,
          li: ({ children }) => <li className="leading-7">{children}</li>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-blue-500 pl-4 my-3 text-gray-400 italic">{children}</blockquote>,
          table: ({ children }) => <div className="overflow-x-auto my-4"><table className="w-full text-sm border-collapse">{children}</table></div>,
          th: ({ children }) => <th className="text-left px-3 py-2 bg-[#1a1f2e] text-gray-300 font-medium border border-white/10 text-sm">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 text-gray-300 border border-white/10 text-sm">{children}</td>,
          hr: () => <hr className="border-white/10 my-5" />,
          strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
          em: ({ children }) => <em className="text-gray-300 italic">{children}</em>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>,
        }}
      >{content}</ReactMarkdown>
      {isStreaming && <span className="inline-block w-0.5 h-4 bg-blue-400 ml-0.5 animate-pulse align-middle" />}
    </div>
  )
}
