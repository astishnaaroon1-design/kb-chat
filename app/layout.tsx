import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'KB Chat — Knowledge Base AI',
  description: 'Chat with your documents using Gemini AI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#0f1219] text-white antialiased">{children}</body>
    </html>
  )
}
