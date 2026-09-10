import { useState } from 'react'
import { sendToolsChat } from '../api/client'
import MarkdownView from '../components/MarkdownView'

const EXAMPLES = [
  'Is InventoryCheckService healthy right now, and how much does its traffic spike during sales events?',
  'Compare the traffic stats for OrderLookupService and CustomerAccountService.',
]

export default function ToolsChatPage() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)

  async function send(text) {
    const q = text ?? input
    if (!q.trim() || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: q }])
    setBusy(true)
    try {
      const res = await sendToolsChat(q)
      setMessages((m) => [...m, { role: 'assistant', text: res.reply }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: 'Error: ' + e.message }])
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="page-header">
        <h2>Tools Chat</h2>
      </div>
      <p className="hint">
        Ask something that needs live operational data — the model will call{' '}
        <code>checkApiHealth</code> / <code>getTrafficStats</code> to answer. Check tools-module's
        console for tool-call logs.
      </p>

      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {EXAMPLES.map((ex) => (
          <button key={ex} className="tag tag-button" onClick={() => send(ex)} disabled={busy}>
            {ex}
          </button>
        ))}
      </div>

      <div className="chat-window">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role}`}>
            {m.role === 'assistant' ? <MarkdownView text={m.text} /> : m.text}
          </div>
        ))}
      </div>

      <div className="row">
        <input
          className="text-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Ask about live service health or traffic..."
          disabled={busy}
        />
        <button className="btn-primary" onClick={() => send()} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  )
}
