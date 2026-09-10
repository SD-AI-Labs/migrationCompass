import { useState } from 'react'
import { askRag, getRagSources, deleteProject } from '../api/client'
import { refreshProjects } from '../state/projectsStore'
import CollapsibleSection from '../components/CollapsibleSection'
import MarkdownView from '../components/MarkdownView'
import ProjectPicker from '../components/ProjectPicker'

export default function RagPage() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sources, setSources] = useState(null)
  const [projects, setProjects] = useState(null)
  const [projectId, setProjectId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  async function ask() {
    if (!question.trim() || busy) return
    setBusy(true)
    setError(null)
    setAnswer(null)
    try {
      const res = await askRag(question, projectId)
      setAnswer(res.answer)
    } catch (e) {
      setError(e.message)
    }
    setBusy(false)
  }

  async function loadSources() {
    try {
      setSources(await getRagSources())
    } catch (e) {
      setError(e.message)
    }
  }

  async function loadProjects() {
    try {
      setProjects(await refreshProjects())
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Delete "${name}"? This permanently removes its embeddings and grounding docs (past agent run history is kept).`)) return
    setDeletingId(id)
    setError(null)
    try {
      await deleteProject(id)
      await loadProjects() // also updates the shared store — every other page's ProjectPicker updates immediately, not just this page's own history table
      if (projectId === id) setProjectId(null)
    } catch (e) {
      setError(e.message)
    }
    setDeletingId(null)
  }

  return (
    <div>
      <div className="page-header">
        <h2>RAG Q&amp;A</h2>
      </div>

      <div className="card">
        <ProjectPicker value={projectId} onChange={setProjectId} />
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="text-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            placeholder="What services or components exist in this codebase?"
            disabled={busy}
          />
          <button className="btn-primary" onClick={ask} disabled={busy}>
            Ask
          </button>
        </div>
        {busy && <p className="hint">Thinking...</p>}
        {error && <p className="error-text">{error}</p>}
        {answer && <div className="answer-box"><MarkdownView text={answer} /></div>}
      </div>

      <CollapsibleSection title="Ingested Sources (diagnostic)">
        <button className="btn-secondary" onClick={loadSources}>Load sources</button>
        {sources && (
          <div>
            <p className="hint">
              {sources.totalFiles} files ingested · groundTruthFilesFound: {sources.groundTruthFilesFound}
              {sources.groundTruthFilesFound > 0 && <span className="error-text"> ⚠ unexpected leak!</span>}
            </p>
            <ul className="source-list">
              {sources.sourcePaths.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Project History">
        <button className="btn-secondary" onClick={loadProjects}>Load projects</button>
        {projects && (
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Files</th><th>Chunks</th><th>Loaded</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.sourceType}</td>
                  <td>{p.fileCount}</td>
                  <td>{p.chunkCount}</td>
                  <td>{new Date(p.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      className="btn-link error-text"
                      onClick={() => handleDelete(p.id, p.name)}
                      disabled={deletingId === p.id}
                    >
                      {deletingId === p.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {projects && projects.length === 0 && <p className="hint">No projects loaded yet.</p>}
      </CollapsibleSection>
    </div>
  )
}
