import { useState } from 'react'
import DashboardPage from './pages/DashboardPage'
import UploadPage from './pages/UploadPage'
import ChatPage from './pages/ChatPage'
import ToolsChatPage from './pages/ToolsChatPage'
import RagPage from './pages/RagPage'
import AgentPage from './pages/AgentPage'
import ReportsPage from './pages/ReportsPage'

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'upload', label: 'Upload' },
  { key: 'chat', label: 'Chat' },
  { key: 'toolsChat', label: 'Tools Chat' },
  { key: 'rag', label: 'RAG Q&A' },
  { key: 'agent', label: 'Agent Pipeline' },
  { key: 'reports', label: 'Reports' },
]

export default function App() {
  const [tab, setTab] = useState('dashboard')

  const navigate = (key) => setTab(key)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">MigrationCompass</div>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`nav-item ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        <div style={{ display: tab === 'dashboard' ? 'block' : 'none' }}>
          <DashboardPage navigate={navigate} />
        </div>
        <div style={{ display: tab === 'upload' ? 'block' : 'none' }}>
          <UploadPage />
        </div>
        <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
          <ChatPage />
        </div>
        <div style={{ display: tab === 'toolsChat' ? 'block' : 'none' }}>
          <ToolsChatPage />
        </div>
        <div style={{ display: tab === 'rag' ? 'block' : 'none' }}>
          <RagPage />
        </div>
        <div style={{ display: tab === 'agent' ? 'block' : 'none' }}>
          <AgentPage />
        </div>
        <div style={{ display: tab === 'reports' ? 'block' : 'none' }}>
          <ReportsPage />
        </div>
      </main>
    </div>
  )
}
