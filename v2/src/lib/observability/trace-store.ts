import { desc, inArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { traceSpans } from "@/db/schema";
import { getLogger } from "@/lib/observability/logger";

import type { TraceSpanInput } from "./waterfall";

/**
 * Reading traces back out of Postgres, for `/admin/traces`.
 *
 * The spans land in the app's own database via the OTel span processor, which is the
 * plan's whole point: no Zipkin container, and the trace page reads data the stack
 * already has.
 *
 * Two things this module deliberately does not do:
 *
 * - **No ownership filter.** `trace_spans` has no `ownerId` (the exporter writes what
 *   OTel gives it), so this is not a per-session surface. It is gated behind
 *   `ADMIN_TRACES_ENABLED` and documented as a demo/operations surface, not an
 *   authorization boundary. Pretending otherwise would be worse than saying so.
 * - **No schema changes.** The rows are read as written and handed to the pure
 *   waterfall builder, which handles malformed data itself.
 */

export type TraceSummaryRow = {
  traceId: string;
  spanCount: number;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  errorCount: number;
  /** The root span's name, when the trace has exactly one root-like span. */
  rootName: string | null;
  /** Whatever `project.id` / `run.id` attributes the instrumented code recorded. */
  projectId: string | null;
  runId: string | null;
};

export type LoadedTrace = {
  summary: TraceSummaryRow;
  spans: TraceSpanInput[];
};

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function attributeOn(attributes: Record<string, unknown> | null, key: string): string | null {
  if (!attributes) return null;
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Recent traces, newest first, with the aggregates the list needs.
 *
 * One grouped query rather than a query per trace: the list shows a page of traces, and
 * an N+1 here would be invisible until someone had a few hundred runs.
 */
export async function listRecentTraces(
  limit = 20,
  db: Database = getDb(),
): Promise<TraceSummaryRow[]> {
  const grouped = await db
    .select({
      traceId: traceSpans.traceId,
      spanCount: sql<number>`count(*)::int`,
      startTime: sql<Date>`min(${traceSpans.startTime})`,
      endTime: sql<Date>`max(${traceSpans.endTime})`,
      errorCount: sql<number>`count(*) filter (where ${traceSpans.statusCode} = 'error')::int`,
    })
    .from(traceSpans)
    .groupBy(traceSpans.traceId)
    .orderBy(desc(sql`min(${traceSpans.startTime})`))
    .limit(limit);

  if (grouped.length === 0) return [];

  const traceIds = grouped.map((row) => row.traceId);

  // A second query for identity attributes and root names, rather than a lateral join:
  // the rows are already indexed by trace id, and this keeps the SQL readable.
  const spanRows = await db
    .select({
      traceId: traceSpans.traceId,
      spanId: traceSpans.spanId,
      parentSpanId: traceSpans.parentSpanId,
      name: traceSpans.name,
      attributes: traceSpans.attributes,
      startTime: traceSpans.startTime,
    })
    .from(traceSpans)
    .where(inArray(traceSpans.traceId, traceIds));

  const roots = new Map<string, { name: string; projectId: string | null; runId: string | null }>();

  for (const row of spanRows) {
    const isRootLike = row.parentSpanId === null || row.parentSpanId === "";
    if (!isRootLike) continue;
    const existing = roots.get(row.traceId);
    // Newest root wins, so a trace with several root spans is described by the one
    // that started it rather than by whichever row came back first.
    if (existing && existing.name !== row.name && existing.name !== "analysis.run") continue;
    roots.set(row.traceId, {
      name: row.name,
      projectId: attributeOn(row.attributes, "project.id"),
      runId: attributeOn(row.attributes, "run.id"),
    });
  }

  return grouped.map((row) => {
    const start = toDate(row.startTime);
    const end = toDate(row.endTime);
    const root = roots.get(row.traceId);

    return {
      traceId: row.traceId,
      spanCount: toNumber(row.spanCount),
      startTime: start,
      endTime: end,
      durationMs: Math.max(0, end.getTime() - start.getTime()),
      errorCount: toNumber(row.errorCount),
      rootName: root?.name ?? null,
      projectId: root?.projectId ?? null,
      runId: root?.runId ?? null,
    };
  });
}

/** Every stored span for one trace. Order is not meaningful — the builder sorts. */
export async function listSpansForTrace(
  traceId: string,
  db: Database = getDb(),
): Promise<TraceSpanInput[]> {
  const rows = await db.select().from(traceSpans).where(inArray(traceSpans.traceId, [traceId]));

  return rows.map((row) => ({
    traceId: row.traceId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    name: row.name,
    kind: row.kind,
    startTime: row.startTime,
    endTime: row.endTime,
    durationMs: row.durationMs,
    statusCode: row.statusCode,
    statusMessage: row.statusMessage,
    attributes: row.attributes,
  }));
}

/**
 * Fails soft, like the exporter: the trace page is an observability surface, and a
 * database hiccup should show an explanation rather than a stack trace. The caller gets
 * an empty list plus a reason it can render.
 */
export async function loadRecentTraces(
  limit = 20,
  db?: Database,
): Promise<{ traces: LoadedTrace[]; error: string | null }> {
  try {
    const summaries = await listRecentTraces(limit, db);
    const traces: LoadedTrace[] = [];

    for (const summary of summaries) {
      traces.push({ summary, spans: await listSpansForTrace(summary.traceId, db) });
    }

    return { traces, error: null };
  } catch (error) {
    getLogger().warn({ error }, "Reading trace spans failed");
    return {
      traces: [],
      error:
        "The stored trace spans could not be read. Check DATABASE_URL and that the migrations have been applied.",
    };
  }
}
