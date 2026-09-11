import type { Metadata } from "next";

import { TraceWaterfallView } from "@/components/trace-waterfall";
import { hasDatabaseConfig } from "@/db/client";
import { observabilityEnv } from "@/lib/env";
import { FIXTURE_TRACE_META, fixtureTraceSpans } from "@/lib/observability/fixture-trace";
import { loadRecentTraces } from "@/lib/observability/trace-store";
import { buildWaterfall, formatDuration } from "@/lib/observability/waterfall";

/**
 * `/admin/traces` — the waterfall view over the spans the app writes to its own
 * Postgres.
 *
 * This is the plan's replacement for a Zipkin container: the OTel spans land in the
 * same database as the application data, and this page reads them back. Swapping in a
 * real backend later (Tempo, Honeycomb) is a change of exporter, not a change here.
 *
 * Two things stated on the page rather than assumed:
 *
 * - **It is not an authorization boundary.** Trace spans have no owner: the exporter
 *   writes what OTel gives it. The page is gated behind `ADMIN_TRACES_ENABLED` and
 *   described as an operations surface — a public deployment should leave it off. It is
 *   not presented as per-session data, because it is not.
 * - **A fixture trace is always shown**, labelled, so the page is demonstrable with an
 *   empty database and no model credential.
 *
 * Trace detail is the same page: each trace expands in place into its waterfall. The
 * plan's rule is "expand in place, never a page navigation", and a trace is exactly the
 * kind of thing a reader flips between.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Traces — Migration Compass",
  description: "OpenTelemetry span waterfalls, read from the application's own Postgres.",
};

function GatePanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel border-[var(--risk-medium)] px-5 py-4">
      <h2 className="text-[15px] font-medium">{title}</h2>
      <div className="caption measure mt-1">{children}</div>
    </section>
  );
}

export default async function TracesPage() {
  const env = observabilityEnv();
  const enabled = env.ADMIN_TRACES_ENABLED;
  const databaseReady = hasDatabaseConfig();

  const loaded = enabled && databaseReady ? await loadRecentTraces(20) : { traces: [], error: null };
  const fixture = buildWaterfall(fixtureTraceSpans());

  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10 sm:px-8 lg:px-12 lg:py-12">
      <header>
        <h1 className="text-[1.75rem] font-semibold tracking-tight sm:text-[2rem]">Traces</h1>
        <p className="caption measure mt-1.5 leading-relaxed">
          OpenTelemetry spans are written to this application&apos;s Postgres and rendered here as waterfalls —
          one process, no separate tracing container. Trace and span ids are the correlation ids in the log
          lines, so a trace and its logs cross-reference directly.
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-8">
        {!enabled && (
          <GatePanel title="The trace viewer is switched off">
            <p>
              <code>ADMIN_TRACES_ENABLED</code> is <code>false</code>. Set it to <code>true</code> to render
              stored spans. It defaults to on for local use and should be off on a public deployment: this
              page is an operations surface, not a per-session view.
            </p>
          </GatePanel>
        )}

        {enabled && !databaseReady && (
          <GatePanel title="No database is configured">
            <p>
              Spans are stored in the same Postgres as the application data, and <code>DATABASE_URL</code> is
              not set. Two commands:
            </p>
            <pre className="tile mt-3 overflow-x-auto border border-[var(--border-subtle)] p-3 text-xs">
              docker compose up -d postgres{"\n"}pnpm db:migrate
            </pre>
          </GatePanel>
        )}

        {enabled && databaseReady && (
          <section>
            <h2 className="eyebrow">Stored traces ({loaded.traces.length})</h2>

            {loaded.error !== null && (
              <p
                role="status"
                className="note mt-3 border-l-2 border-l-[var(--risk-critical)] border-solid text-[var(--risk-critical)]"
              >
                {loaded.error}
              </p>
            )}

            {loaded.error === null && loaded.traces.length === 0 && (
              <div className="note measure mt-3">
                <p className="text-[13px] text-[var(--foreground)]">No traces have been stored yet.</p>
                <p className="mt-1">
                  Spans appear once something instrumented runs with tracing on. To produce some: check{" "}
                  <code>OTEL_ENABLED=true</code> in <code>.env</code>, start the app, and either run an
                  analysis from the project page or upload a codebase. Each run writes one trace. The fixture
                  trace below renders regardless, so this page is never empty.
                </p>
              </div>
            )}

            <ul className="mt-3 flex flex-col gap-2.5">
              {loaded.traces.map(({ summary, spans }) => {
                const waterfall = buildWaterfall(spans);

                return (
                  <li key={summary.traceId} className="panel-quiet px-4 py-3">
                    <details>
                      <summary className="cursor-pointer">
                        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                          <span className="font-medium">
                            {summary.rootName ?? "trace"} <span className="text-[var(--muted)]">·</span>{" "}
                            {summary.spanCount} span(s)
                          </span>
                          <span className="tabular-nums">{formatDuration(summary.durationMs)}</span>
                          <span className="text-xs text-[var(--muted)] tabular-nums">
                            {summary.startTime.toISOString()}
                          </span>
                          {summary.errorCount > 0 && (
                            <span className="text-xs text-[var(--risk-critical)]">
                              {summary.errorCount} error span(s)
                            </span>
                          )}
                          <span className="font-mono text-[11px] text-[var(--muted)]">{summary.traceId}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--muted)]">
                          {summary.projectId ? `project ${summary.projectId}` : "no project attribute"}
                          {summary.runId ? ` · run ${summary.runId}` : ""}
                        </p>
                      </summary>

                      <div className="mt-3">
                        <TraceWaterfallView
                          waterfall={waterfall}
                          label={`trace ${summary.traceId.slice(0, 8)}${summary.traceId.slice(-4)}`}
                          note="Spans are placed by their parent links, so an out-of-order or partially written trace still renders."
                        />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section>
          <h2 className="eyebrow">Fixture trace</h2>
          <p className="meta measure mt-2">
            {FIXTURE_TRACE_META.label}. It exists so this page can be demonstrated and reviewed without a
            model credential, an analysis run or a database — and it deliberately contains an orphan span, an
            error span, out-of-order rows and credential-shaped attributes, so the incomplete-data handling
            and the redaction are visible rather than merely claimed.
          </p>
          <div className="mt-3">
            <TraceWaterfallView
              waterfall={fixture}
              label={`fixture trace ${FIXTURE_TRACE_META.traceId.slice(0, 8)}${FIXTURE_TRACE_META.traceId.slice(-4)}`}
              note={`Fixed timestamps from ${FIXTURE_TRACE_META.startTime.toISOString()} so the fixture renders identically on every request.`}
            />
          </div>
        </section>

        <section className="panel-quiet px-5 py-4">
          <h2 className="text-[15px] font-medium">What is not on this page</h2>
          <ul className="caption mt-2 list-disc pl-5">
            <li>
              <strong>No credentials, ever.</strong> Attributes whose key looks like a credential
              (<code>authorization</code>, <code>apiKey</code>, <code>cookie</code>, tokens, secrets, passwords)
              are replaced before rendering, and values that look like keys or JWTs are replaced too. The
              withheld keys are listed per span so the omission is visible.
            </li>
            <li>
              <strong>No per-session filtering.</strong> Spans carry no owner id. This page is an operations
              surface behind an environment flag, not a per-visitor view.
            </li>
            <li>
              <strong>No live tail.</strong> The page reads what has been flushed to Postgres; spans still in a
              batch processor&apos;s buffer are not shown yet.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
