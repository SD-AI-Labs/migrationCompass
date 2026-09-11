import type { TraceSpanInput } from "./waterfall";

/**
 * A deterministic fixture trace.
 *
 * `/admin/traces` must be demonstrable without a live model run — no API key, no
 * Ollama, no analysis — which is the same constraint every other demonstrable surface
 * in this project has to satisfy. So a synthetic trace is checked in and rendered on
 * the page, clearly labelled as a fixture, and the tests build from it.
 *
 * It is not decorative: it deliberately contains every structure the page has to
 * survive.
 *
 * - **Nesting** four levels deep: `analysis.run` → stage → LLM call → retry.
 * - **An orphan span**, whose parent was written by a different exporter process that
 *   never flushed — the case an incomplete trace actually looks like.
 * - **Out-of-order rows**, in the array order a batch exporter produces them
 *   (children before parents), to prove placement is computed from `parentSpanId`.
 * - **An error span**, with a status message, so the error treatment is visible.
 * - **A long span and a very short span**, so durations and bars differ visibly.
 * - **Credential-shaped attributes** (`authorization`, `apiKey`, `cookie`) that must
 *   never reach the rendered page.
 */

type FixtureSpan = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  /** Milliseconds after the trace start. */
  offsetMs: number;
  durationMs: number;
  statusCode?: string;
  statusMessage?: string;
  attributes?: Record<string, unknown>;
};

export const FIXTURE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

/** Base instant: fixed, so the fixture renders identical timestamps on every run. */
const BASE_TIME = Date.UTC(2026, 8, 10, 14, 30, 0);

const FIXTURE_SPANS: FixtureSpan[] = [
  {
    spanId: "b7ad6b7169203331",
    parentSpanId: null,
    name: "analysis.run",
    kind: "internal",
    offsetMs: 0,
    // Long enough to contain every child, including the concurrent Architecture/Risk
    // stages, so the root's self time is a real remainder rather than zero.
    durationMs: 19_600,
    attributes: {
      "project.id": "bb6b9238-02f7-461b-9f3f-e718c1ff8389",
      "run.id": "7b2eaba2-e595-4c8b-91af-fac415b36e05",
      "project.name": "sample-legacy-api.zip",
      service: "migration-compass",
    },
  },
  {
    spanId: "0af7651916cd43dd",
    parentSpanId: "b7ad6b7169203331",
    name: "agent.discovery",
    kind: "internal",
    offsetMs: 40,
    durationMs: 6_120,
    attributes: { "agent.stage": "discovery", "tool.iterations": 2 },
  },
  {
    spanId: "1a2b3c4d5e6f7081",
    parentSpanId: "0af7651916cd43dd",
    name: "llm.chat",
    kind: "client",
    offsetMs: 220,
    durationMs: 4_980,
    // The credential-shaped attributes: none of these may appear on the page.
    attributes: {
      "llm.model": "deepseek-chat",
      "http.request.method": "POST",
      authorization: "Bearer sk-fixture-must-never-be-rendered",
      apiKey: "sk-fixture-must-never-be-rendered-either",
      "llm.prompt.tokens": 12_842,
      "llm.completion.tokens": 1_204,
    },
  },
  {
    spanId: "e7f80912233445a6",
    parentSpanId: "1a2b3c4d5e6f7081",
    name: "http.request",
    kind: "client",
    offsetMs: 260,
    durationMs: 4_880,
    attributes: {
      "http.request.method": "POST",
      "server.address": "api.deepseek.com",
      "http.response.status_code": 200,
      "http.url": "https://api.deepseek.com/v1/chat/completions",
    },
  },
  {
    spanId: "2b3c4d5e6f708192",
    parentSpanId: "0af7651916cd43dd",
    name: "rag.retrieve",
    kind: "client",
    offsetMs: 5_340,
    durationMs: 620,
    attributes: {
      "db.system": "postgresql",
      "db.statement": "select id, source, 1 - (embedding <=> $1) as similarity from chunks limit 6",
      "retrieval.rows": 6,
      cookie: "mc_owner=fixture-session-must-never-render",
    },
  },
  {
    spanId: "3c4d5e6f708192a3",
    parentSpanId: "0af7651916cd43dd",
    name: "rag.retrieve",
    kind: "client",
    offsetMs: 6_010,
    durationMs: 140,
    statusCode: "error",
    statusMessage: "context deadline exceeded",
    attributes: { "retrieval.queries": 3, "retrieval.error": "timeout" },
  },
  {
    spanId: "4d5e6f708192a3b4",
    parentSpanId: "b7ad6b7169203331",
    name: "agent.architecture",
    kind: "internal",
    offsetMs: 6_200,
    durationMs: 5_010,
    attributes: { "agent.stage": "architecture", "tool.iterations": 1 },
  },
  {
    spanId: "5e6f708192a3b4c5",
    parentSpanId: "4d5e6f708192a3b4",
    name: "llm.chat",
    kind: "client",
    offsetMs: 6_260,
    durationMs: 4_640,
    attributes: {
      "llm.model": "deepseek-chat",
      authorization: "Bearer sk-fixture-second-call",
      "llm.prompt.tokens": 11_037,
    },
  },
  {
    spanId: "6f708192a3b4c5d6",
    parentSpanId: "b7ad6b7169203331",
    name: "agent.risk",
    kind: "internal",
    offsetMs: 6_240,
    durationMs: 5_700,
    attributes: { "agent.stage": "risk", "tool.iterations": 3 },
  },
  {
    spanId: "708192a3b4c5d6e7",
    parentSpanId: "6f708192a3b4c5d6",
    name: "llm.chat",
    kind: "client",
    offsetMs: 6_300,
    durationMs: 3_120,
    attributes: { "llm.model": "deepseek-chat", sessionToken: "fixture-session-token" },
  },
  {
    spanId: "8192a3b4c5d6e7f8",
    parentSpanId: "6f708192a3b4c5d6",
    name: "tool.checkApiHealth",
    kind: "internal",
    offsetMs: 9_460,
    durationMs: 38,
    attributes: { "tool.name": "checkApiHealth", "tool.result": "no data available" },
  },
  {
    spanId: "92a3b4c5d6e7f809",
    parentSpanId: "b7ad6b7169203331",
    name: "agent.comparison",
    kind: "internal",
    offsetMs: 12_600,
    durationMs: 3_480,
    attributes: { "agent.stage": "comparison" },
  },
  {
    spanId: "a3b4c5d6e7f80912",
    parentSpanId: "92a3b4c5d6e7f809",
    name: "llm.chat",
    kind: "client",
    offsetMs: 12_640,
    durationMs: 3_260,
    attributes: { llm_model: "deepseek-chat", password: "fixture-password" },
  },
  {
    spanId: "b4c5d6e7f8091223",
    parentSpanId: "b7ad6b7169203331",
    name: "db.persistFindings",
    kind: "client",
    offsetMs: 16_220,
    durationMs: 640,
    attributes: { "db.system": "postgresql", "db.rows": 3 },
  },
  {
    spanId: "c5d6e7f809122334",
    parentSpanId: "b7ad6b7169203331",
    name: "span.flush",
    kind: "internal",
    offsetMs: 17_000,
    durationMs: 1_380,
    attributes: { "exporter.name": "postgres" },
  },
  {
    // Deliberate orphan: its parent was never written, so the page has to place it at
    // the root and say the trace is incomplete rather than dropping it.
    spanId: "d6e7f80912233445",
    parentSpanId: "ffffffffffffffff",
    name: "agent.critique",
    kind: "internal",
    offsetMs: 5_900,
    durationMs: 210,
    attributes: { "agent.stage": "critique", "critique.round": 1 },
  },
];

/**
 * The fixture trace, in the order a batch exporter flushes: children before parents,
 * and not sorted by time. Anything that renders correctly from this array is rendering
 * from the parent links, not from the input order.
 */
export function fixtureTraceSpans(traceId = FIXTURE_TRACE_ID): TraceSpanInput[] {
  const flushOrder = [
    "b7ad6b7169203331",
    "0af7651916cd43dd",
    "1a2b3c4d5e6f7081",
    "e7f80912233445a6",
    "2b3c4d5e6f708192",
    "3c4d5e6f708192a3",
    "4d5e6f708192a3b4",
    "5e6f708192a3b4c5",
    "6f708192a3b4c5d6",
    "708192a3b4c5d6e7",
    "8192a3b4c5d6e7f8",
    "92a3b4c5d6e7f809",
    "a3b4c5d6e7f80912",
    "b4c5d6e7f8091223",
    "c5d6e7f809122334",
    "d6e7f80912233445",
  ];

  const byId = new Map(FIXTURE_SPANS.map((span) => [span.spanId, span]));

  return flushOrder
    .map((spanId) => byId.get(spanId))
    .filter((span): span is FixtureSpan => span !== undefined)
    .map((span) => ({
      traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTime: new Date(BASE_TIME + span.offsetMs),
      endTime: new Date(BASE_TIME + span.offsetMs + span.durationMs),
      durationMs: span.durationMs,
      statusCode: span.statusCode ?? "unset",
      statusMessage: span.statusMessage ?? null,
      attributes: span.attributes ?? {},
    }));
}

/** Fixed metadata for the fixture, so the page can describe it like a real trace. */
export const FIXTURE_TRACE_META = {
  traceId: FIXTURE_TRACE_ID,
  startTime: new Date(BASE_TIME),
  label: "fixture trace — synthetic data, not a real run",
};
