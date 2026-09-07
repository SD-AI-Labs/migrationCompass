import { useState } from 'react'
import { loadExampleProject, uploadSourceZip, uploadGrounding, uploadLogs, uploadOperationalData } from '../api/client'
import { refreshProjects } from '../state/projectsStore'

export default function UploadPage() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [duplicateInfo, setDuplicateInfo] = useState(null)

  const [sourceFile, setSourceFile] = useState(null)
  const [groundingFiles, setGroundingFiles] = useState([])
  const [logFiles, setLogFiles] = useState([])
  const [healthFile, setHealthFile] = useState(null)
  const [trafficFile, setTrafficFile] = useState(null)

  async function run(fn) {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await fn()
      setResult(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Loading the example creates a new project — every other already-mounted
  // page's ProjectPicker needs to hear about it, not just this page.
  async function handleLoadExample() {
    await run(loadExampleProject)
    refreshProjects().catch(() => {}) // non-fatal if this particular refresh fails — pickers just fall back to their own next fetch
  }

  async function handleUploadSource(override) {
    setBusy(true)
    setError(null)
    setResult(null)
    if (!override) setDuplicateInfo(null)
    try {
      const r = await uploadSourceZip(sourceFile, override)
      if (r.duplicate) {
        setDuplicateInfo(r)
      } else {
        setDuplicateInfo(null)
        setResult(r)
        refreshProjects().catch(() => {}) // new project created — sync every page's picker
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Upload</h2>
      </div>

      <div className="card">
        <h3>Option A — Try the bundled example</h3>
        <p className="hint">
          Loads OrderVault, a fictional legacy order-management system, plus its ground-truth docs —
          zero setup, good for a first look at the whole pipeline.
        </p>
        <button className="btn-primary" disabled={busy} onClick={handleLoadExample}>
          Load OrderVault Example
        </button>
      </div>

      <div className="card">
        <h3>Option B — Analyze your own codebase</h3>
        <p className="hint">
          Zip up your project first. Every file with a recognized extension (.java .py .js .ts .go .rb
          .cs .kt .xml .yaml .yml .json .sql .md) gets indexed — no folder convention required.
        </p>
        <input type="file" accept=".zip" onChange={(e) => { setSourceFile(e.target.files[0]); setDuplicateInfo(null) }} />
        <div className="row">
          <button
            className="btn-primary"
            disabled={busy || !sourceFile}
            onClick={() => handleUploadSource(false)}
          >
            Upload Source
          </button>
        </div>

        {duplicateInfo && (
          <div className="card" style={{ borderColor: 'var(--warn, #b58900)', marginTop: 10 }}>
            <p className="hint error-text">{duplicateInfo.message}</p>
            <p className="hint">
              If some files were actually updated, this shouldn't normally happen — a real change produces a
              different hash. If you're sure you want to re-ingest it anyway (e.g. testing), you can override:
            </p>
            <button className="btn-secondary" disabled={busy} onClick={() => handleUploadSource(true)}>
              Override and Upload Anyway
            </button>
          </div>
        )}

        <p className="hint" style={{ marginTop: 10 }}>
          Uploading a new project starts fresh and becomes the <strong>active</strong> project for
          Q&amp;A and analysis — earlier projects' data isn't deleted, just no longer the default target
          (see README for how "active" is determined). Byte-for-byte duplicate zips are detected and
          rejected unless you explicitly override.
        </p>
      </div>

      <div className="card">
        <h3>Optional — Application logs</h3>
        <p className="hint">
          Upload log files for the <em>currently active</em> project — additive, doesn't replace source
          code. Gives the Discovery and Risk agents real evidence of runtime behavior (errors,
          exceptions, warnings), not just static code analysis. Accepts .log, .txt, .out files.
        </p>
        <input type="file" multiple accept=".log,.txt,.out" onChange={(e) => setLogFiles(Array.from(e.target.files))} />
        <div className="row">
          <button
            className="btn-secondary"
            disabled={busy || logFiles.length === 0}
            onClick={() => run(() => uploadLogs(logFiles))}
          >
            Upload Logs
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Optional — Grounding docs</h3>
        <p className="hint">
          Upload a hand-written architecture summary or known-issues doc for the <em>currently loaded</em>{' '}
          project. Used later to score the AI pipeline's own analysis against your reference — never fed
          to the agents during their own reasoning.
        </p>
        <input type="file" multiple onChange={(e) => setGroundingFiles(Array.from(e.target.files))} />
        <div className="row">
          <button
            className="btn-secondary"
            disabled={busy || groundingFiles.length === 0}
            onClick={() => run(() => uploadGrounding(groundingFiles))}
          >
            Upload Grounding
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Optional — Operational data</h3>
        <p className="hint">
          Upload real health/traffic data for the Risk Agent's live-data tools. Without this, tools-module
          keeps using the bundled OrderVault example data as a fallback.
        </p>
        <div className="row">
          <div>
            <label className="hint">Health status JSON</label>
            <input type="file" accept=".json" onChange={(e) => setHealthFile(e.target.files[0])} />
          </div>
          <div>
            <label className="hint">Traffic stats JSON</label>
            <input type="file" accept=".json" onChange={(e) => setTrafficFile(e.target.files[0])} />
          </div>
        </div>
        <div className="row">
          <button
            className="btn-secondary"
            disabled={busy || !healthFile || !trafficFile}
            onClick={() => run(() => uploadOperationalData(healthFile, trafficFile))}
          >
            Upload Operational Data
          </button>
        </div>
      </div>

      {busy && <p className="hint">Working — ingestion can take a minute for larger projects (real embedding calls to Ollama)...</p>}
      {error && <p className="error-text">Error: {error}</p>}
      {result && (
        <div className="card">
          <h3>Result</h3>
          <pre className="result-pre">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
