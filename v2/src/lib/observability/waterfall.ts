/**
 * Waterfall construction for `/admin/traces`.
 *
 * Pure logic, deliberately not React-dependent: a waterfall is a tree plus some
 * arithmetic, and the parts that go wrong are structural — a span whose parent never
 * arrived, spans that arrive out of order, a cycle, a duplicate id, a duration that
 * disagrees with its timestamps. Those are testable here, with literals, no browser
 * and no database. The page receives a finished model and draws it.
 *
 * The input is the shape the OTel → Postgres exporter writes (`trace_spans`), so the
 * page can pass rows straight in.
 *
 * Two rules the model enforces, both about not misleading the reader:
 *
 * 1. **A span is placed by its parent, not by its arrival.** Trace rows come back from
 *    the database in whatever order the index returns, and a batch exporter can write
 *    children before parents. Placement is therefore computed from `parentSpanId`
 *    alone, and the input order can only affect nothing.
 * 2. **Anything structurally impossible is reported, not hidden.** A parent that
 *    never arrived, a child that starts before its parent, a duration that disagrees
 *    with its own timestamps, a depth beyond the cap — each becomes an issue on the
 *    model so the page can say "this trace is incomplete" instead of drawing a
 *    confident-looking waterfall over broken data.
 */

/** One persisted span, as the exporter writes it. */
export type TraceSpanInput = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: Date | string;
  endTime: Date | string;
  /** Milliseconds. Accepts a string because the `numeric` column round-trips as one. */
  durationMs: number | string;
  statusCode?: string | null;
  statusMessage?: string | null;
  attributes?: Record<string, unknown> | null;
};

export type WaterfallSpan = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  /** Duration with the union of its children's durations removed, floored at 0. */
  selfMs: number;
  /** Nesting depth, 0 for a root. */
  depth: number;
  /** Start relative to the trace's earliest span, for the timeline bar. */
  offsetMs: number;
  /** Children, in start order. */
  children: WaterfallSpan[];
  statusCode: string;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  /** Attribute keys that were dropped for looking like a credential. */
  redactedAttributes: string[];
  /** True when the parent is not in this trace set. */
  orphan: boolean;
  /** True when anything structural about this span is off — see `issue`. */
  suspicious: boolean;
  issue: string | null;
  error: boolean;
};

export type TraceWaterfall = {
  traceId: string;
  /** Depth-first, start-ordered. The order the page renders. */
  spans: WaterfallSpan[];
  roots: WaterfallSpan[];
  byId: Map<string, WaterfallSpan>;
  spanCount: number;
  /** Earliest start and latest end across the trace. */
  startTime: Date;
  endTime: Date;
  durationMs: number;
  maxDepth: number;
  orphans: WaterfallSpan[];
  /** Structural problems, as sentences the page can show verbatim. */
  issues: string[];
  /** Rows dropped before construction, and why. */
  skipped: { spanId: string; reason: string }[];
  /** Spans that existed but were not rendered, once the cap was reached. */
  truncated: number;
};

/** Depth cap: deep enough for any real trace, shallow enough that a cycle cannot hang a page. */
export const MAX_WATERFALL_DEPTH = 32;
/** Span cap for one trace, so a runaway trace cannot make the page unusable. */
export const MAX_TRACE_SPANS = 2000;

/**
 * Attribute keys whose *values* are never rendered.
 *
 * Matched case-insensitively as substrings, so `authorization`, `x-authorization`,
 * `http.request.header.authorization` and `apiKey` are all covered by one rule. This
 * is the last line of defence for the page's "never expose credentials" requirement:
 * instrumentation should not be recording these, but a page that renders whatever it
 * finds is one bad attribute away from publishing a key.
 */
const SECRET_KEY_PATTERNS = [
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "api-key",
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "credential",
  "private_key",
  "privatekey",
  "session",
  "signature",
  "bearer",
];

/** Values that look like a credential regardless of their key. */
const SECRET_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._-]{8,}/i,
  /\bsk-[a-z0-9]{8,}/i,
  /\bsk_[a-z0-9]{8,}/i,
  /\beyJ[a-z0-9._-]{10,}/i, // a JWT
];

export const REDACTED = "[redacted]";

function looksSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

function valueLooksSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Strips credential-shaped attributes and truncates the rest.
 *
 * Recursive, because an attribute value can be an object (the exporter stores whatever
 * OTel was given). Long strings are truncated rather than dropped: an attribute is
 * usually the most useful thing on a span, and losing it entirely would make the page
 * useless.
 */
export function redactAttributes(attributes: Record<string, unknown> | null | undefined): {
  attributes: Record<string, unknown>;
  redacted: string[];
} {
  const redacted: string[] = [];
  const output: Record<string, unknown> = {};

  const walk = (value: unknown, key: string, depth: number): unknown => {
    if (value === null || value === undefined) return null;

    if (looksSecret(key)) {
      if (!redacted.includes(key)) redacted.push(key);
      return REDACTED;
    }

    if (typeof value === "string") {
      if (valueLooksSecret(value)) {
        if (!redacted.includes(key)) redacted.push(key);
        return REDACTED;
      }
      return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    }

    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();

    if (depth >= 4) return "[nested]";

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, key, depth + 1));
    }

    if (typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        nested[nestedKey] = walk(nestedValue, nestedKey, depth + 1);
      }
      return nested;
    }

    return String(value);
  };

  for (const [key, value] of Object.entries(attributes ?? {})) {
    output[key] = walk(value, key, 0);
  }

  return { attributes: output, redacted };
}

function toDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDuration(value: number | string, startTime: Date, endTime: Date): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  // A missing or negative duration is recovered from the timestamps where possible,
  // because the timestamps are the ground truth and the stored duration is derived.
  return Math.max(0, endTime.getTime() - startTime.getTime());
}

/** Human duration: `1.4s`, `820ms`, `2m 03s`. Deterministic, no locale involved. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Self time: the span's duration minus the **union** of its children's intervals.
 *
 * Not the sum of the children's durations. A fan-out (Architecture and Risk running
 * concurrently, which this graph does) means siblings overlap, and summing them
 * double-counts time and can exceed the parent — reporting a self time of zero for a
 * span that spent real time working. Merging the intervals is the honest arithmetic:
 * "time in this span that was not spent inside a child".
 */
function selfTimeFor(span: WaterfallSpan): number {
  if (span.children.length === 0) return span.durationMs;

  const parentStart = span.startTime.getTime();
  const intervals = span.children
    .map((child) => {
      const start = Math.max(0, child.startTime.getTime() - parentStart);
      const end = Math.max(start, child.endTime.getTime() - parentStart);
      return [start, end] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let [openStart, openEnd] = intervals[0] as [number, number];

  for (const [start, end] of intervals.slice(1)) {
    if (start <= openEnd) {
      openEnd = Math.max(openEnd, end);
      continue;
    }
    covered += openEnd - openStart;
    openStart = start;
    openEnd = end;
  }
  covered += openEnd - openStart;

  return Math.max(0, Math.round((span.durationMs - covered) * 1000) / 1000);
}

/**
 * Builds the tree.
 *
 * Placement is by `parentSpanId` only, so nothing about the input order can change the
 * result. Cycles (a impossible in OTel, cheap to guard against) are detected by
 * walking up from each span and are re-rooted rather than followed forever.
 */
export function buildWaterfall(
  input: TraceSpanInput[],
  options: { maxDepth?: number; maxSpans?: number } = {},
): TraceWaterfall {
  const maxDepth = options.maxDepth ?? MAX_WATERFALL_DEPTH;
  const maxSpans = options.maxSpans ?? MAX_TRACE_SPANS;
  const skipped: { spanId: string; reason: string }[] = [];

  const sorted = [...input].sort((a, b) => {
    const left = toDate(a.startTime)?.getTime() ?? 0;
    const right = toDate(b.startTime)?.getTime() ?? 0;
    return left - right || String(a.spanId).localeCompare(String(b.spanId));
  });

  const seen = new Set<string>();
  const candidates: {
    spanId: string;
    parentSpanId: string | null;
    name: string;
    kind: string;
    startTime: Date;
    endTime: Date;
    durationMs: number;
    statusCode: string;
    statusMessage: string | null;
    attributes: Record<string, unknown>;
    redacted: string[];
  }[] = [];

  for (const span of sorted) {
    const spanId = typeof span.spanId === "string" && span.spanId.length > 0 ? span.spanId : null;
    if (spanId === null) {
      skipped.push({ spanId: "(missing)", reason: "The span has no span id, so it cannot be placed in a tree." });
      continue;
    }
    if (seen.has(spanId)) {
      skipped.push({ spanId, reason: "A span with this id already appeared in the trace; the duplicate was dropped." });
      continue;
    }
    if (candidates.length >= maxSpans) {
      skipped.push({ spanId, reason: `The trace exceeded ${maxSpans} spans; this one was not rendered.` });
      continue;
    }

    const startTime = toDate(span.startTime);
    const endTime = toDate(span.endTime);
    if (startTime === null || endTime === null) {
      skipped.push({ spanId, reason: "The span has an unparseable timestamp, so its position on the timeline is unknown." });
      continue;
    }

    seen.add(spanId);
    const { attributes, redacted } = redactAttributes(span.attributes);

    candidates.push({
      spanId,
      parentSpanId:
        typeof span.parentSpanId === "string" && span.parentSpanId.length > 0 ? span.parentSpanId : null,
      name: typeof span.name === "string" && span.name.length > 0 ? span.name : "(unnamed span)",
      kind: typeof span.kind === "string" ? span.kind : "internal",
      startTime,
      endTime,
      durationMs: toDuration(span.durationMs, startTime, endTime),
      statusCode: span.statusCode ?? "unset",
      statusMessage: span.statusMessage ?? null,
      attributes,
      redacted,
    });
  }

  const byId = new Map<string, WaterfallSpan>();
  for (const candidate of candidates) {
    const { redacted, ...rest } = candidate;
    byId.set(candidate.spanId, {
      ...rest,
      redactedAttributes: redacted,
      selfMs: candidate.durationMs,
      depth: 0,
      offsetMs: 0,
      children: [],
      orphan: false,
      suspicious: false,
      issue: null,
      error: candidate.statusCode === "error",
    });
  }

  const issues: string[] = [];
  const orphans: WaterfallSpan[] = [];
  let missingParentOrphans = 0;
  let cyclicOrphans = 0;

  /** Walks up the parent chain, so a cycle cannot be mistaken for a root. */
  const isCyclic = (spanId: string): boolean => {
    const walkSeen = new Set<string>([spanId]);
    let current = byId.get(spanId)?.parentSpanId ?? null;
    while (current !== null) {
      if (walkSeen.has(current)) return true;
      walkSeen.add(current);
      current = byId.get(current)?.parentSpanId ?? null;
    }
    return false;
  };

  for (const span of byId.values()) {
    const parentId = span.parentSpanId;
    if (parentId === null) continue;

    if (!byId.has(parentId)) {
      span.orphan = true;
      span.issue = `Its parent span (${parentId}) is not in this trace, so it is shown at the root.`;
      span.suspicious = true;
      orphans.push(span);
      missingParentOrphans += 1;
      continue;
    }

    if (parentId === span.spanId || isCyclic(span.spanId)) {
      span.orphan = true;
      span.issue = "Following its parent links returns to this span, so it is shown at the root.";
      span.suspicious = true;
      orphans.push(span);
      cyclicOrphans += 1;
      continue;
    }

    const parent = byId.get(parentId);
    parent?.children.push(span);
  }

  const roots = [...byId.values()].filter((span) => span.parentSpanId === null || span.orphan);

  // Depth first, children in start order — the order the page renders, and the reason
  // the model is deterministic rather than dependent on Map iteration order.
  const ordered: WaterfallSpan[] = [];
  let deepest = 0;

  const visit = (span: WaterfallSpan, depth: number): void => {
    if (depth > maxDepth) {
      span.issue ??= `Nesting exceeded ${maxDepth} levels; deeper spans were not rendered.`;
      span.suspicious = true;
      issues.push(`A branch of this trace nests deeper than ${maxDepth} levels and was truncated.`);
      return;
    }

    span.depth = depth;
    deepest = Math.max(deepest, depth);
    ordered.push(span);

    span.children.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.spanId.localeCompare(b.spanId),
    );
    for (const child of span.children) visit(child, depth + 1);
  };

  for (const root of roots.sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.spanId.localeCompare(b.spanId),
  )) {
    visit(root, 0);
  }

  const startTime = ordered.reduce(
    (earliest, span) => (span.startTime < earliest ? span.startTime : earliest),
    ordered[0]?.startTime ?? new Date(0),
  );
  const endTime = ordered.reduce(
    (latest, span) => (span.endTime > latest ? span.endTime : latest),
    ordered[0]?.endTime ?? new Date(0),
  );

  for (const span of ordered) {
    span.offsetMs = Math.max(0, span.startTime.getTime() - startTime.getTime());
    span.selfMs = selfTimeFor(span);
  }

  for (const span of ordered) {
    const stored = toDuration(span.durationMs, span.startTime, span.endTime);
    const measured = span.endTime.getTime() - span.startTime.getTime();
    if (Math.abs(measured - stored) > Math.max(5, stored * 0.05)) {
      span.suspicious = true;
      span.issue ??=
        `Its recorded duration (${Math.round(stored)}ms) disagrees with its timestamps ` +
        `(${Math.round(measured)}ms), so treat the timing as approximate.`;
    }
  }

  if (byId.size === 0 && input.length > 0) {
    issues.push("None of the stored rows for this trace could be read as spans.");
  }
  if (missingParentOrphans > 0) {
    issues.push(
      `${missingParentOrphans} span(s) reference a parent that is not in this trace — it is incomplete, so ` +
        `the waterfall shows them at the root rather than pretending the hierarchy is whole.`,
    );
  }
  if (cyclicOrphans > 0) {
    issues.push(
      `${cyclicOrphans} span(s) name a parent chain that returns to themselves (a cycle); they are shown at ` +
        `the root instead of being followed.`,
    );
  }

  const rootsOut = roots.sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.spanId.localeCompare(b.spanId),
  );

  return {
    traceId: input.find((span) => typeof span.traceId === "string" && span.traceId.length > 0)?.traceId ?? "",
    spans: ordered,
    roots: rootsOut,
    byId,
    spanCount: ordered.length,
    startTime,
    endTime,
    durationMs: Math.max(0, endTime.getTime() - startTime.getTime()),
    maxDepth: deepest,
    orphans,
    issues,
    skipped,
    truncated: skipped.filter((entry) => entry.reason.includes("exceeded")).length,
  };
}
