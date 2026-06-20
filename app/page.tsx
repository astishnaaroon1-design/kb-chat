import FileSidebar from '@/components/FileSidebar'
import ChatPanel from '@/components/ChatPanel'

export default function Home() {
  return (
    <main className="flex h-screen overflow-hidden">
      <FileSidebar />
      <ChatPanel />
    </main>
  )
}
