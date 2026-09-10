// Base URLs for each Spring Boot module. Hardcoded to localhost ports
// matching each module's application.yml — fine for local dev; would
// become env-configurable if this were ever deployed anywhere.
export const BASES = {
  chat: 'http://localhost:8080',
  tools: 'http://localhost:8081',
  rag: 'http://localhost:8082',
  agent: 'http://localhost:8083',
  report: 'http://localhost:8084',
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${url} -> HTTP ${res.status} ${text}`)
  }
  const contentType = res.headers.get('content-type') || ''
  return contentType.includes('application/json') ? res.json() : res.text()
}

// ---- Health ----
export async function checkHealth(base) {
  try {
    const data = await getJson(`${base}/api/health`)
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---- chat-module ----
export function sendChatMessage(conversationId, message) {
  return postJson(`${BASES.chat}/api/chat`, { conversationId, message })
}

export async function streamChatMessage(conversationId, message, onChunk) {
  const res = await fetch(`${BASES.chat}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message }),
  })
  if (!res.ok || !res.body) throw new Error(`Stream failed: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Per the SSE spec, when a single event's data spans multiple physical
  // lines, the server sends it as MULTIPLE consecutive "data:" lines (one
  // per line of the original text), terminated by a blank line — the
  // client is responsible for rejoining those lines with "\n" to
  // reconstruct the original multi-line value. DeepSeek routinely emits
  // deltas containing embedded newlines (paragraph breaks, table rows,
  // list items, markdown headers like "\n\n## Section"), so this matters
  // constantly, not just in edge cases. Without this buffering, every
  // embedded newline was silently dropped — e.g. a delta of "foo\nbar"
  // arrives as two separate "data:" lines ("data:foo", "data:bar"), and
  // calling onChunk once per line with no separator produced "foobar",
  // collapsing paragraph breaks, markdown tables, and list formatting.
  let pendingEventLines = []

  function flushPendingEvent() {
    if (pendingEventLines.length > 0) {
      onChunk(pendingEventLines.join('\n'))
      pendingEventLines = []
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep any incomplete line for next chunk
    for (const line of lines) {
      if (line.startsWith('data:')) {
        // Spring WebFlux's SSE writer serializes a Flux<String> as
        // "data:<content>" with NO space after the colon (confirmed against
        // Spring's ServerSentEventHttpMessageWriter — unlike a hand-built SSE
        // stream, it doesn't add the conventional delimiter space). That means
        // any leading space in the sliced content is part of the model's own
        // token (tokens routinely start with a space to mark a word boundary,
        // e.g. " question"), not a delimiter to strip.
        pendingEventLines.push(line.slice(5))
      } else if (line === '') {
        // Blank line = SSE event terminator — flush whatever data: lines
        // we've accumulated for this event as ONE onChunk call, joined
        // with the newlines the original text actually had.
        flushPendingEvent()
      }
      // Any other line (e.g. "event:", "id:", ":comment") is ignored —
      // this stream only ever uses bare "data:" events.
    }
  }
  flushPendingEvent() // flush a final event that wasn't followed by a trailing blank line
}

// ---- tools-module ----
export function sendToolsChat(message) {
  return postJson(`${BASES.tools}/api/tools-chat`, { message })
}

export async function uploadOperationalData(healthFile, trafficFile) {
  const form = new FormData()
  form.append('health', healthFile)
  form.append('traffic', trafficFile)
  const res = await fetch(`${BASES.tools}/api/tools/upload/operational-data`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
  return res.json()
}

// ---- rag-module ----
export function askRag(question, projectId) {
  return postJson(`${BASES.rag}/api/rag/ask`, { question, projectId: projectId || null })
}

export function getRagSources() {
  return getJson(`${BASES.rag}/api/rag/sources`)
}

export function getProjects() {
  return getJson(`${BASES.rag}/api/rag/projects`)
}

export async function deleteProject(projectId) {
  const res = await fetch(`${BASES.rag}/api/rag/projects/${projectId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 204) throw new Error(`Delete failed: HTTP ${res.status}`)
}

// Returns { duplicate: true, ... } instead of throwing when the backend
// detects a byte-for-byte repeat upload (HTTP 409) — lets the caller show
// an "override?" prompt instead of a generic error. Any OTHER failure
// still throws normally.
export async function uploadSourceZip(file, override) {
  const form = new FormData()
  form.append('file', file)
  const url = `${BASES.rag}/api/rag/upload/source${override ? '?override=true' : ''}`
  const res = await fetch(url, { method: 'POST', body: form })
  if (res.status === 409) {
    return await res.json() // { duplicate: true, existingProjectId, existingProjectName, existingProjectCreatedAt, message }
  }
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
  return res.json()
}

export async function uploadGrounding(files) {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const res = await fetch(`${BASES.rag}/api/rag/upload/grounding`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
  return res.json()
}

export async function uploadLogs(files) {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const res = await fetch(`${BASES.rag}/api/rag/upload/logs`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
  return res.json()
}

export function loadExampleProject() {
  return postJson(`${BASES.rag}/api/rag/upload/load-example`)
}

// ---- agent-module ----
export function startAgentJob(projectId) {
  const url = projectId
    ? `${BASES.agent}/api/agent/analyze/start?projectId=${projectId}`
    : `${BASES.agent}/api/agent/analyze/start`
  return postJson(url)
}

export function getAgentStatus(runId) {
  return getJson(`${BASES.agent}/api/agent/analyze/status/${runId}`)
}

export function getAgentResult(runId) {
  return getJson(`${BASES.agent}/api/agent/analyze/result/${runId}`)
}

// projectId is optional — omit for the full cross-project history (Reports tab),
// pass it to scope to one project's runs (Agent Pipeline tab's "past runs" list).
export function getRuns(projectId) {
  const url = projectId
    ? `${BASES.agent}/api/agent/runs?projectId=${projectId}`
    : `${BASES.agent}/api/agent/runs`
  return getJson(url)
}

export function getRun(id) {
  return getJson(`${BASES.agent}/api/agent/runs/${id}`)
}

// ---- structured-output-module ----
// Always starts a brand-new full pipeline run — see generateReportForProject
// for the version that reuses an existing completed run instead.
export function generateReportFromPipeline(projectId) {
  const url = projectId
    ? `${BASES.report}/api/report/generate-from-pipeline?projectId=${projectId}`
    : `${BASES.report}/api/report/generate-from-pipeline`
  return postJson(url)
}

// Reuses the latest COMPLETE run for this project if one exists (zero or
// one LLM call) instead of always re-running the full 4-agent pipeline.
export function generateReportForProject(projectId) {
  return postJson(`${BASES.report}/api/report/generate-for-project/${projectId}`)
}
