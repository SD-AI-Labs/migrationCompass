import { useState, useRef, useEffect } from 'react'
import { startAgentJob, getAgentStatus, getAgentResult, getRuns } from '../api/client'
import CollapsibleSection from '../components/CollapsibleSection'
import MarkdownView from '../components/MarkdownView'
import ProjectPicker from '../components/ProjectPicker'
import StatusBadge from '../components/StatusBadge'

const STEPS = ['DISCOVERY', 'ARCHITECTURE', 'RISK', 'COMPARISON', 'DONE']

const STEP_INFO = {
  DISCOVERY: {
    label: 'Discovery',
    desc: 'The Discovery Agent is querying the knowledge base to figure out what services/components exist and how they work — starting broad, then going deep on each thing it finds.',
  },
  ARCHITECTURE: {
    label: 'Architecture',
    desc: 'The Architecture Agent is reasoning over the Discovery findings to propose a target microservices design and a phased migration plan.',
  },
  RISK: {
    label: 'Risk',
    desc: 'The Risk Agent is checking live health/traffic data for each discovered service and combining it with code-level risk factors to rank migration risk.',
  },
  COMPARISON: {
    label: 'Comparison',
    desc: 'Comparing the Discovery and Risk output against any uploaded grounding docs — scoring what the AI got right, missed, or overstated.',
  },
  DONE: {
    label: 'Done',
    desc: 'Complete.',
  },
}

function formatSeconds(s) {
  if (s == null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

export default function AgentPage() {
  const [projectId, setProjectId] = useState(null)
  const [runId, setRunId] = useState(null)
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(false)
  const [pastRuns, setPastRuns] = useState(null)
  const [viewingRunId, setViewingRunId] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    return () => clearInterval(pollRef.current)
  }, [])

  useEffect(() => {
    if (projectId) loadPastRuns()
  }, [projectId])

  async function loadPastRuns() {
    try {
      setPastRuns(await getRuns(projectId))
    } catch (e) {
      setError(e.message)
    }
  }

  async function start() {
    setStarting(true)
    setError(null)
    setResult(null)
    setStatus(null)
    setViewingRunId(null)
    try {
      const { runId: id } = await startAgentJob(projectId)
      setRunId(id)
      poll(id)
    } catch (e) {
      setError(e.message)
    }
    setStarting(false)
  }

  function poll(id) {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const s = await getAgentStatus(id)
        setStatus(s)
        if (s.status === 'COMPLETE') {
          clearInterval(pollRef.current)
          const r = await getAgentResult(id)
          setResult(r)
          loadPastRuns()
        } else if (s.status === 'FAILED') {
          clearInterval(pollRef.current)
          setError('Run failed — check agent-module server logs for details.')
          loadPastRuns()
        }
      } catch (e) {
        clearInterval(pollRef.current)
        setError(e.message)
      }
    }, 3000)
  }

  async function viewPastRun(id) {
    setError(null)
    setStatus(null)
    setViewingRunId(id)
    try {
      setResult(await getAgentResult(id))
    } catch (e) {
      setError(e.message)
      setResult(null)
    }
  }

  const currentStepIndex = status ? STEPS.indexOf(status.currentStep) : -1

  return (
    <div>
      <div className="page-header">
        <h2>Agent Pipeline</h2>
      </div>

      <div className="card">
        <p className="hint">
          Runs the full multi-agent migration analysis: Discovery → Architecture → Risk → Comparison, against
          whichever project you pick below. Requires tools-module and rag-module running.
        </p>
        <ProjectPicker value={projectId} onChange={setProjectId} />
        <div style={{ marginTop: 10 }}>
          <button
            className="btn-primary"
            onClick={start}
            disabled={starting || !projectId || (status && status.status === 'RUNNING')}
          >
            {starting ? 'Starting...' : 'Run Full Analysis'}
          </button>
        </div>
      </div>

      {projectId && (
        <CollapsibleSection title={`Past Runs for this Project${pastRuns ? ` (${pastRuns.length})` : ''}`}>
          {pastRuns && pastRuns.length === 0 && <p className="hint">No runs yet for this project — start one above.</p>}
          {pastRuns && pastRuns.length > 0 && (
            <table className="data-table">
              <thead>
                <tr><th>Started</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {pastRuns.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.startedAt).toLocaleString()}</td>
                    <td><StatusBadge level={r.status} /></td>
                    <td>
                      {r.status === 'COMPLETE' && (
                        <button className="btn-link" onClick={() => viewPastRun(r.id)}>View</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CollapsibleSection>
      )}

      {error && <p className="error-text">{error}</p>}

      {status && (
        <div className="card">
          <h3>Progress</h3>
          <div className="step-tracker">
            {STEPS.filter((s) => s !== 'DONE').map((s, i) => (
              <div
                key={s}
                className={`step-item ${i < currentStepIndex || status.status === 'COMPLETE' ? 'done' : i === currentStepIndex ? 'active' : ''}`}
              >
                <div className="step-dot">{i < currentStepIndex || status.status === 'COMPLETE' ? '✓' : i + 1}</div>
                <div className="step-label">{STEP_INFO[s].label}</div>
              </div>
            ))}
          </div>

          {status.status === 'RUNNING' && (
            <>
              <p><strong>{STEP_INFO[status.currentStep]?.label}</strong> — {STEP_INFO[status.currentStep]?.desc}</p>
              <p className="hint">
                Elapsed: {formatSeconds(status.elapsedSeconds)} · Estimated remaining: {formatSeconds(status.estimatedRemainingSeconds)}
                <br />
                <em>Estimate is computed from your own past completed runs — the first run ever uses a rough static guess.</em>
              </p>
            </>
          )}
          {status.status === 'COMPLETE' && <p className="hint">Complete — see results below.</p>}
        </div>
      )}

      {result && (
        <div>
          {viewingRunId && <p className="hint">Viewing past run {viewingRunId}.</p>}
          <CollapsibleSection title="Discovery Report" defaultOpen>
            <MarkdownView text={result.discoveryReport} />
          </CollapsibleSection>
          <CollapsibleSection title="Architecture Proposal">
            <MarkdownView text={result.architectureProposal} />
          </CollapsibleSection>
          <CollapsibleSection title="Risk Assessment">
            <MarkdownView text={result.riskAssessment} />
          </CollapsibleSection>
          <CollapsibleSection title="Ground Truth Comparison">
            <MarkdownView text={result.groundTruthComparison} />
          </CollapsibleSection>
        </div>
      )}
    </div>
  )
}
