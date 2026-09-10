import { useState, useEffect, useRef } from 'react'
import html2pdf from 'html2pdf.js'
import { getRuns, getRun, generateReportFromPipeline, generateReportForProject } from '../api/client'
import CollapsibleSection from '../components/CollapsibleSection'
import MarkdownView from '../components/MarkdownView'
import StatusBadge from '../components/StatusBadge'
import ProjectPicker from '../components/ProjectPicker'

function StructuredReportView({ report }) {
  return (
    <div>
      <div className="card">
        <h3>{report.systemName}</h3>
        <p>{report.executiveSummary}</p>
      </div>

      {report.targetArchitecture && (
        <div className="card">
          <h3>Target Architecture</h3>
          <p>{report.targetArchitecture.migrationApproach}</p>
          <div>
            <strong>Proposed services:</strong>
            <br />
            {(report.targetArchitecture.proposedServices || []).map((s) => (
              <span key={s} className="tag">{s}</span>
            ))}
          </div>

          <div style={{ marginTop: 10 }}>
            <strong>Key technology choices:</strong>
            <br />
            {(report.targetArchitecture.keyTechnologyChoices || []).map((s) => (
              <span key={s} className="tag">{s}</span>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(report.serviceRisks) && (
        <div className="card">
          <h3>Service Risk Assessment</h3>

          {report.serviceRisks.map((r) => (
            <div
              key={r.serviceName}
              className={
                'risk-card ' +
                (r.riskLevel || '').toLowerCase()
              }
            >
              <div>
                <strong>{r.serviceName}</strong>{' '}
                <StatusBadge level={r.riskLevel} />
              </div>

              <ul>
                {(r.riskFactors || []).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>

              <div>
                <em>Recommendation:</em> {r.recommendation}
              </div>
            </div>
          ))}
        </div>
      )}

      {Array.isArray(report.phasedPlan) && (
        <div className="card">
          <h3>Phased Migration Plan</h3>

          {[...report.phasedPlan]
            .sort((a, b) => a.phaseNumber - b.phaseNumber)
            .map((p) => (
              <div key={p.phaseNumber} className="phase">
                <div className="phase-num">{p.phaseNumber}</div>

                <div>
                  <strong>{p.title}</strong>
                  <br />

                  {(p.servicesInvolved || []).map((s) => (
                    <span key={s} className="tag">{s}</span>
                  ))}

                  <p
                    className="hint"
                    style={{ marginTop: 6 }}
                  >
                    {p.rationale}
                  </p>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

export default function ReportsPage() {
  const [runs, setRuns] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [generatingLabel, setGeneratingLabel] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [projectId, setProjectId] = useState(null)

  // PDF export state
  const [exportingPdf, setExportingPdf] = useState(false)
  const [exportingRunId, setExportingRunId] = useState(null)

  const elapsedRef = useRef(null)

  // Ref for the report content that should be exported
  const reportRef = useRef(null)

  async function loadRuns() {
    setLoading(true)

    try {
      setRuns(await getRuns())
    } catch (e) {
      setError(e.message)
    }

    setLoading(false)
  }

  useEffect(() => {
    loadRuns()
  }, [])

  useEffect(() => {
    return () => clearInterval(elapsedRef.current)
  }, [])

  function startElapsedTimer() {
    setElapsed(0)
    clearInterval(elapsedRef.current)

    elapsedRef.current = setInterval(
      () => setElapsed((s) => s + 1),
      1000
    )
  }

  function stopElapsedTimer() {
    clearInterval(elapsedRef.current)
  }

  async function selectRun(id) {
    setLoading(true)
    setError(null)

    try {
      setSelected(await getRun(id))
    } catch (e) {
      setError(e.message)
    }

    setLoading(false)
  }

  /*
   * Export the currently selected report.
   */
  async function exportReportAsPdf() {
    if (!selected || !reportRef.current || exportingPdf) {
      return
    }

    setExportingPdf(true)
    setError(null)

    try {
      const reportName =
        structuredReport?.systemName ||
        'migration-report'

      const safeReportName = reportName
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()

      const filename =
        safeReportName +
        '-' +
        selected.id +
        '.pdf'

      const options = {
        margin: 10,
        filename: filename,

        image: {
          type: 'jpeg',
          quality: 0.98,
        },

        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
        },

        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },

        pagebreak: {
          mode: ['css', 'legacy'],
        },
      }

      await html2pdf()
        .set(options)
        .from(reportRef.current)
        .save()
    } catch (e) {
      console.error('PDF export failed:', e)
      setError('Unable to export PDF: ' + e.message)
    } finally {
      setExportingPdf(false)
    }
  }

  /*
   * Export a report directly from the Run History table.
   *
   * The run is loaded first, then selected. Once React has rendered
   * the report, exportReportAsPdf() is called.
   */
  async function exportRunAsPdf(run) {
    if (
      !run ||
      !run.structuredReportJson ||
      exportingPdf
    ) {
      return
    }

    setExportingPdf(true)
    setExportingRunId(run.id)
    setError(null)

    try {
      const runData = await getRun(run.id)

      setSelected(runData)

      /*
       * Wait for React to render the selected report before
       * attempting to access reportRef.current.
       */
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve)
        })
      })

      if (!reportRef.current) {
        throw new Error(
          'Report content was not rendered yet.'
        )
      }

      let reportData = null

      try {
        reportData = runData.structuredReportJson
          ? JSON.parse(runData.structuredReportJson)
          : null
      } catch (e) {
        reportData = null
      }

      const reportName =
        reportData?.systemName ||
        'migration-report'

      const safeReportName = reportName
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()

      const filename =
        safeReportName +
        '-' +
        run.id +
        '.pdf'

      const options = {
        margin: 10,
        filename: filename,

        image: {
          type: 'jpeg',
          quality: 0.98,
        },

        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
        },

        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: 'portrait',
        },

        pagebreak: {
          mode: ['css', 'legacy'],
        },
      }

      await html2pdf()
        .set(options)
        .from(reportRef.current)
        .save()
    } catch (e) {
      console.error('PDF export failed:', e)
      setError('Unable to export PDF: ' + e.message)
    } finally {
      setExportingPdf(false)
      setExportingRunId(null)
    }
  }

  // The reuse-aware path: skips re-running the agent pipeline (and re-calling
  // the LLM) if a completed run already exists for this project — see
  // structured-output-module's FullPipelineReportService.generateForProject.
  async function runForProject() {
    if (!projectId) return

    setGenerating(true)
    setGeneratingLabel(
      'Generating report for selected project (reusing an existing run if one exists)...'
    )
    setError(null)
    startElapsedTimer()

    try {
      await generateReportForProject(projectId)
      await loadRuns()
    } catch (e) {
      setError(e.message)
    }

    stopElapsedTimer()
    setGenerating(false)
  }

  // Always-fresh path: ignores any existing run, starts a brand-new full pipeline.
  async function runFullReport() {
    setGenerating(true)
    setGeneratingLabel(
      'Running full pipeline + report from scratch (this can take several minutes)...'
    )
    setError(null)
    startElapsedTimer()

    try {
      await generateReportFromPipeline(projectId)
      await loadRuns()
    } catch (e) {
      setError(e.message)
    }

    stopElapsedTimer()
    setGenerating(false)
  }

  let structuredReport = null

  try {
    structuredReport = selected?.structuredReportJson
      ? JSON.parse(selected.structuredReportJson)
      : null
  } catch (e) {
    console.error('Unable to parse structured report:', e)
    structuredReport = null
  }

  function formatElapsed(s) {
    const m = Math.floor(s / 60)
    const sec = s % 60

    return m > 0
      ? m + 'm ' + sec + 's'
      : sec + 's'
  }

  return (
    <div>
      <div className="page-header">
        <h2>Reports</h2>

        <button
          className="btn-secondary"
          onClick={loadRuns}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      <div className="card">
        <ProjectPicker
          value={projectId}
          onChange={setProjectId}
        />

        <p
          className="hint"
          style={{ marginTop: 10 }}
        >
          <strong>Recommended:</strong> reuses the selected
          project's latest completed agent run if one exists —
          zero or one LLM call instead of re-running the whole
          4-agent pipeline. Falls back to a fresh run only if
          this project has never been analyzed.
        </p>

        <button
          className="btn-primary"
          onClick={runForProject}
          disabled={
            generating ||
            !projectId
          }
        >
          {generating
            ? 'Generating...'
            : 'Generate Report for Selected Project'}
        </button>

        <p
          className="hint"
          style={{ marginTop: 14 }}
        >
          <strong>Always fresh:</strong> ignores any existing
          run and starts a brand-new full pipeline execution
          for the selected project (or the most recent project
          if none is selected). Slow — prefer the option above
          unless you specifically want a new run.
        </p>

        <button
          className="btn-secondary"
          onClick={runFullReport}
          disabled={generating}
        >
          {generating
            ? 'Generating...'
            : 'Generate New Full Report'}
        </button>

        {generating && (
          <p
            className="hint"
            style={{ marginTop: 10 }}
          >
            {generatingLabel}
            <br />
            Elapsed: {formatElapsed(elapsed)}
            <br />
            <em>
              This is a single long-running request rather than
              a polled background job (unlike the Agent Pipeline
              tab) — the elapsed timer above is the only progress
              signal available for now; the page will update once
              it completes.
            </em>
          </p>
        )}
      </div>

      {error && (
        <p className="error-text">
          {error}
        </p>
      )}

      <div className="card">
        <h3>Run History</h3>

        <table className="data-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Step</th>
              <th>Has Report</th>
              <th>Export</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  {new Date(
                    r.startedAt
                  ).toLocaleString()}
                </td>

                <td>
                  <StatusBadge
                    level={r.status}
                  />
                </td>

                <td>
                  {r.currentStep}
                </td>

                <td>
                  {r.structuredReportJson
                    ? '✓'
                    : '—'}
                </td>

                <td>
                  <button
                    className="btn-link"
                    onClick={() =>
                      exportRunAsPdf(r)
                    }
                    disabled={
                      !r.structuredReportJson ||
                      exportingPdf
                    }
                  >
                    {exportingRunId === r.id
                      ? 'Exporting...'
                      : 'Export PDF'}
                  </button>
                </td>

                <td>
                  <button
                    className="btn-link"
                    onClick={() =>
                      selectRun(r.id)
                    }
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {runs.length === 0 &&
          !loading && (
            <p className="hint">
              No runs yet.
            </p>
          )}
      </div>

      {selected && (
        <div>
          <div
            className="page-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <h3>
              Run Detail — {selected.id}
            </h3>

            <button
              className="btn-primary"
              onClick={exportReportAsPdf}
              disabled={
                exportingPdf ||
                loading ||
                !reportRef.current
              }
            >
              {exportingPdf
                ? 'Exporting PDF...'
                : 'Export Report as PDF'}
            </button>
          </div>

          {/* Only the content inside this element is exported */}
          <div ref={reportRef}>
            {structuredReport && (
              <StructuredReportView
                report={structuredReport}
              />
            )}

            {!structuredReport && (
              <p className="hint">
                No structured report attached to
                this run yet.
              </p>
            )}

            <CollapsibleSection
              title="Discovery Report"
            >
              <MarkdownView
                text={
                  selected.discoveryReport
                }
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Architecture Proposal"
            >
              <MarkdownView
                text={
                  selected.architectureProposal
                }
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Risk Assessment"
            >
              <MarkdownView
                text={
                  selected.riskAssessment
                }
              />
            </CollapsibleSection>

            <CollapsibleSection
              title="Ground Truth Comparison"
            >
              <MarkdownView
                text={
                  selected.groundTruthComparison
                }
              />
            </CollapsibleSection>
          </div>
        </div>
      )}
    </div>
  )
}