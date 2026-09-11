import { REDACTED, formatDuration, type TraceWaterfall, type WaterfallSpan } from "@/lib/observability/waterfall";

/**
 * The waterfall renderer.
 *
 * A server component with no client JavaScript of its own: every disclosure is a
 * `<details>`, so the whole page works with the keyboard and without hydration, and the
 * browser does the work.
 *
 * Three decisions worth stating, because they are about not misleading a reader:
 *
 * 1. **The bar is not the only signal.** Every duration, offset and timestamp is
 *    present as text, so the timeline is readable without seeing the graphic and the
 *    page does not depend on colour to convey status.
 * 2. **Attributes are behind a disclosure, and credential-shaped ones never render.**
 *    The redaction happens in `waterfall.ts` (and is tested there); this component
 *    only knows that some keys were dropped, and says so.
 * 3. **Structural problems are stated, not smoothed over.** An incomplete trace is
 *    labelled incomplete, and the spans that could not be placed are shown at the root
 *    with the reason attached rather than dropped.
 */

function SpanRow({ span, traceDurationMs }: { span: WaterfallSpan; traceDurationMs: number }) {
  const total = traceDurationMs > 0 ? traceDurationMs : 1;
  const left = Math.min(100, (span.offsetMs / total) * 100);
  const width = Math.max(0.5, Math.min(100 - left, (span.durationMs / total) * 100));

  return (
    <li className="border-b border-[var(--border-subtle)] py-2 last:border-b-0">
      <details>
        <summary className="cursor-pointer list-none">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
            <span
              className="font-medium text-[var(--foreground)]"
              // Indentation carries the hierarchy visually; the depth is also in the
              // accessible text below, so nesting is not conveyed by whitespace alone.
              style={{ paddingLeft: span.depth * 12 }}
            >
              {span.name}
            </span>
            <span className="text-[10px] text-[var(--muted)]">
              {span.kind}
            </span>
            <span className="tabular-nums">{formatDuration(span.durationMs)}</span>
            {span.selfMs !== span.durationMs && (
              <span className="text-[var(--muted)] tabular-nums">self {formatDuration(span.selfMs)}</span>
            )}
            <span className="text-[var(--muted)] tabular-nums">+{formatDuration(span.offsetMs)}</span>
            {span.error && (
              <span className="text-[var(--risk-critical)]">error{span.statusMessage ? `: ${span.statusMessage}` : ""}</span>
            )}
            {span.orphan && <span className="text-[var(--risk-medium)]">orphan span</span>}
            {span.suspicious && !span.orphan && <span className="text-[var(--risk-medium)]">inconsistent timing</span>}
            <span className="text-[10px] text-[var(--muted)]">depth {span.depth}</span>
          </div>

          <div
            className="relative mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-[var(--surface)]"
            aria-hidden="true"
          >
            <div
              className={`absolute h-full rounded-sm ${
                span.error ? "bg-[var(--risk-critical)]" : "bg-[var(--accent)]"
              }`}
              style={{ left: `${left}%`, width: `${width}%`, opacity: span.orphan ? 0.6 : 1 }}
            />
          </div>
        </summary>

        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 border-l border-[var(--border-subtle)] pl-3 text-[11px] sm:grid-cols-2">
          <div>
            <dt className="text-[var(--muted)]">Span id</dt>
            <dd className="font-mono break-all">{span.spanId}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Parent span id</dt>
            <dd className="font-mono break-all">{span.parentSpanId ?? "— (root)"}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Started</dt>
            <dd className="tabular-nums">{span.startTime.toISOString()}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Ended</dt>
            <dd className="tabular-nums">{span.endTime.toISOString()}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Status</dt>
            <dd>{span.statusCode}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Nesting depth</dt>
            <dd className="tabular-nums">{span.depth}</dd>
          </div>
          {span.attributes && Object.keys(span.attributes).length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Attributes</dt>
              <dd>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {Object.entries(span.attributes).map(([key, value]) => (
                    <li key={key} className="break-all">
                      <span className="font-mono text-[var(--foreground)]">{key}</span>
                      <span className="text-[var(--muted)]"> = </span>
                      <span className="font-mono">
                        {typeof value === "string" ? value : JSON.stringify(value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {span.redactedAttributes.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Withheld</dt>
              <dd className="text-[var(--risk-medium)]">
                {span.redactedAttributes.length} attribute(s) that look like credentials were replaced with{" "}
                <span className="font-mono">{REDACTED}</span>: {span.redactedAttributes.join(", ")}
              </dd>
            </div>
          )}
          {span.issue && (
            <div className="sm:col-span-2">
              <dt className="text-[var(--muted)]">Note</dt>
              <dd className="text-[var(--risk-medium)]">{span.issue}</dd>
            </div>
          )}
        </dl>
      </details>
    </li>
  );
}

export function TraceWaterfallView({
  waterfall,
  label,
  note,
}: {
  waterfall: TraceWaterfall;
  /** A short descriptor shown above the waterfall, e.g. "fixture trace". */
  label: string;
  /** Any extra sentence, e.g. why this trace is shown. */
  note?: string;
}) {
  if (waterfall.spanCount === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--border)] p-3 text-xs text-[var(--muted)]">
        <p className="text-[var(--foreground)]">{label}: no spans to draw.</p>
        {waterfall.skipped.length > 0 ? (
          <ul className="mt-2 list-disc pl-5">
            {waterfall.skipped.map((entry) => (
              <li key={`${entry.spanId}-${entry.reason}`}>
                {entry.spanId}: {entry.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">Nothing was recorded for this trace.</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-[10px] text-[var(--muted)] tabular-nums">
          {waterfall.spanCount} span(s) · {formatDuration(waterfall.durationMs)} total · depth {waterfall.maxDepth}
          {waterfall.orphans.length > 0 ? ` · ${waterfall.orphans.length} orphan(s)` : ""}
          {waterfall.skipped.length > 0 ? ` · ${waterfall.skipped.length} row(s) skipped` : ""}
        </p>
      </div>

      {note && <p className="mt-1 text-[10px] text-[var(--muted)]">{note}</p>}

      <ul className="mt-2 list-none" aria-label={`Span waterfall for ${label}`}>
        {waterfall.spans.map((span) => (
          <SpanRow key={span.spanId} span={span} traceDurationMs={waterfall.durationMs} />
        ))}
      </ul>

      {waterfall.issues.length > 0 && (
        <div className="mt-2 rounded-md border border-[var(--risk-medium)] px-3 py-2">
          <p className="text-xs text-[var(--risk-medium)]">This trace is incomplete or inconsistent</p>
          <ul className="mt-1 list-disc pl-5 text-[10px] text-[var(--muted)]">
            {waterfall.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {waterfall.skipped.length > 0 && (
        <details className="mt-2 rounded-md border border-[var(--border)] p-2">
          <summary className="cursor-pointer text-[11px] text-[var(--muted)]">
            {waterfall.skipped.length} stored row(s) could not be drawn
          </summary>
          <ul className="mt-1 list-disc pl-5 text-[10px] text-[var(--muted)]">
            {waterfall.skipped.map((entry) => (
              <li key={`${entry.spanId}-${entry.reason}`}>
                {entry.spanId}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
