import { useEffect, useState } from 'react'
import { getCachedProjects, refreshProjects, subscribeToProjects } from '../state/projectsStore'

// Shared "pick which project" dropdown. Defaults to the most-recently-created
// project once loaded (matching the backend's own default when no projectId
// is passed), but lets the person pick any earlier one instead.
//
// Reads from the shared projectsStore (not a local fetch) so that deleting
// a project on the RAG tab, or uploading a new one on the Upload tab,
// immediately updates every OTHER already-mounted page's picker too — see
// projectsStore.js's comment for why a local-only fetch isn't enough now
// that pages stay permanently mounted.
export default function ProjectPicker({ value, onChange, label = 'Project' }) {
  const [projects, setProjects] = useState(getCachedProjects())
  const [error, setError] = useState(null)

  useEffect(() => {
    if (projects === null) {
      refreshProjects().catch((e) => setError(e.message))
    }
    const unsubscribe = subscribeToProjects((updated) => {
      setProjects(updated)
      // If the currently selected project just got deleted elsewhere,
      // fall back to the most recent remaining one instead of silently
      // keeping a selection that no longer exists.
      if (value && !updated.some((p) => p.id === value)) {
        onChange(updated.length > 0 ? updated[0].id : null)
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (projects && projects.length > 0 && !value) {
      onChange(projects[0].id) // default to most recent
    }
  }, [projects])

  if (error) return <p className="hint error-text">Couldn't load projects: {error}</p>
  if (projects === null) return <p className="hint">Loading projects...</p>
  if (projects.length === 0) return <p className="hint">No projects loaded yet — go to Upload first.</p>

  return (
    <div className="row" style={{ alignItems: 'center' }}>
      <label className="hint" style={{ marginRight: 8 }}>{label}:</label>
      <select className="text-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {new Date(p.createdAt).toLocaleString()}
            {p.id === projects[0].id ? ' (most recent)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
