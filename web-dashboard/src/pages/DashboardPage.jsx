import { useEffect, useState } from 'react'
import { BASES, checkHealth } from '../api/client'
import { refreshProjects, subscribeToProjects, getCachedProjects } from '../state/projectsStore'
import CollapsibleSection from '../components/CollapsibleSection'

const SERVICES = [
  { key: 'chat', name: 'chat-module', desc: 'Conversational assistant with memory + streaming' },
  { key: 'tools', name: 'tools-module', desc: 'AI tool/function calling against live operational data' },
  { key: 'rag', name: 'rag-module', desc: 'Document Q&A over the loaded codebase' },
  { key: 'agent', name: 'agent-module', desc: 'Multi-agent migration planning pipeline' },
  { key: 'report', name: 'structured-output-module', desc: 'Structured JSON migration report extraction' },
]

export default function DashboardPage({ navigate }) {
  const [statuses, setStatuses] = useState({})
  const [checking, setChecking] = useState(false)
  const [projects, setProjects] = useState(getCachedProjects())
  const [projectsError, setProjectsError] = useState(null)

  async function refresh() {
    setChecking(true)
    const results = {}
    await Promise.all(
      SERVICES.map(async (s) => {
        results[s.key] = await checkHealth(BASES[s.key])
      })
    )
    setStatuses(results)
    setChecking(false)

    try {
      setProjects(await refreshProjects())
      setProjectsError(null)
    } catch (e) {
      setProjectsError(e.message)
    }
  }

  useEffect(() => {
    refresh()
    // Also react live to a delete/upload triggered from another
    // already-mounted page (RAG tab, Upload tab) — see projectsStore.js.
    return subscribeToProjects(setProjects)
  }, [])

  const currentProject = projects && projects.length > 0 ? projects[0] : null

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <button className="btn-secondary" onClick={refresh} disabled={checking}>
          {checking ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      <div className="card">
        <h3>Current Project</h3>
        {projectsError && <p className="hint error-text">Couldn't reach rag-module: {projectsError}</p>}
        {!projectsError && !currentProject && (
          <p className="hint">
            No project loaded yet. Go to <a onClick={() => navigate('upload')}>Upload</a> to load the
            OrderVault example or upload your own codebase.
          </p>
        )}
        {currentProject && (
          <div className="project-summary">
            <div>
              <strong>{currentProject.name}</strong>{' '}
              <span className="tag">{currentProject.sourceType}</span>
            </div>
            <div className="hint">
              {currentProject.fileCount} files, {currentProject.chunkCount} chunks indexed
              &nbsp;·&nbsp; loaded {new Date(currentProject.createdAt).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <CollapsibleSection title={`All Uploaded Projects${projects ? ` (${projects.length})` : ''}`}>
        {!projectsError && projects && projects.length === 0 && <p className="hint">No projects loaded yet.</p>}
        {!projectsError && projects && projects.length > 0 && (
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Files</th><th>Chunks</th><th>Loaded</th></tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}{p.id === currentProject?.id ? <span className="tag" style={{ marginLeft: 6 }}>active</span> : null}</td>
                  <td>{p.sourceType}</td>
                  <td>{p.fileCount}</td>
                  <td>{p.chunkCount}</td>
                  <td>{new Date(p.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          Every project's data stays queryable — pick any of these by name in RAG Q&amp;A, Agent Pipeline, or
          Reports rather than only ever using the most recent upload.
        </p>
      </CollapsibleSection>

      <div className="grid">
        {SERVICES.map((s) => {
          const status = statuses[s.key]
          const isUp = status?.ok
          return (
            <div key={s.key} className="card service-card">
              <div className="service-card-header">
                <span className={`dot ${isUp ? 'up' : status ? 'down' : ''}`}></span>
                <strong>{s.name}</strong>
              </div>
              <p className="hint">{s.desc}</p>
              <p className="hint">
                {status === undefined
                  ? 'Checking...'
                  : isUp
                  ? `Up · port ${BASES[s.key].split(':').pop()}`
                  : 'Not reachable'}
              </p>
            </div>
          )
        })}
      </div>

      <div className="card">
        <h3>Quick Start</h3>
        <ol className="hint" style={{ paddingLeft: 20 }}>
          <li>Start all 5 backend modules (see project README) and PostgreSQL (`docker compose up -d`)</li>
          <li>Go to <a onClick={() => navigate('upload')}>Upload</a> and load the OrderVault example, or upload your own project</li>
          <li>Try <a onClick={() => navigate('rag')}>RAG Q&amp;A</a> to ask questions about the loaded code</li>
          <li>Run the full <a onClick={() => navigate('agent')}>Agent Pipeline</a> for a complete migration analysis</li>
          <li>Check <a onClick={() => navigate('reports')}>Reports</a> for history of past runs</li>
        </ol>
      </div>
    </div>
  )
}
