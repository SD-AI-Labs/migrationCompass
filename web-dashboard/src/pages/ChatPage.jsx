import { useState, useRef } from 'react'
import { sendChatMessage, streamChatMessage } from '../api/client'
import MarkdownView from '../components/MarkdownView'

export default function ChatPage() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(true)
  const [busy, setBusy] = useState(false)
  const conversationId = useRef(crypto.randomUUID())

  async function send() {
    if (!input.trim() || busy) return
    const userMessage = input
    setInput('')
    setMessages((m) => [...m, { role: 'user', text: userMessage }])
    setBusy(true)

    if (streaming) {
      setMessages((m) => [...m, { role: 'assistant', text: '' }])
      try {
        await streamChatMessage(conversationId.current, userMessage, (chunk) => {
          setMessages((m) => {
            const copy = [...m]
            copy[copy.length - 1] = { role: 'assistant', text: copy[copy.length - 1].text + chunk }
            return copy
          })
        })
      } catch (e) {
        setMessages((m) => [...m, { role: 'assistant', text: 'Error: ' + e.message }])
      }
    } else {
      try {
        const res = await sendChatMessage(conversationId.current, userMessage)
        setMessages((m) => [...m, { role: 'assistant', text: res.reply }])
      } catch (e) {
        setMessages((m) => [...m, { role: 'assistant', text: 'Error: ' + e.message }])
      }
    }
    setBusy(false)
  }

  return (
    <div>
      <div className="page-header">
        <h2>Chat</h2>
        <label className="hint">
          <input type="checkbox" checked={streaming} onChange={(e) => setStreaming(e.target.checked)} />
          {' '}Stream responses
        </label>
      </div>

      <div className="chat-window">
        {messages.length === 0 && <p className="hint">Ask about migration risks, patterns, or general architecture questions.</p>}
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
          placeholder="What risks come with migrating a SOAP API to REST?"
          disabled={busy}
        />
        <button className="btn-primary" onClick={send} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  )
}
