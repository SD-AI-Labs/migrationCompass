import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { getDb, hasDatabaseConfig } from "@/db/client";
import { observabilityEnv } from "@/lib/env";
import { getLogger } from "./logger";
import { traceSpans } from "@/db/schema";

/**
 * Writes finished spans into the app's own Postgres database instead of
 * exporting them to a separate tracing backend. The plan accepts the tradeoff
 * explicitly: no Zipkin flame graphs, in exchange for zero extra infrastructure
 * and a `/admin/traces` route that renders from data already in the stack.
 *
 * Because OTel is the instrumentation layer regardless, swapping in a real
 * backend later (Tempo, Honeycomb) is a change of exporter, not a rewrite of
 * how spans get created.
 */

/** Shape-independent conversion so this stays testable without real spans. */
export type SpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  startTime: Date;
  endTime: Date;
  durationMs: string;
  statusCode: string;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
};

/**
 * Pure: ReadableSpan → row. Exported so tests can assert the mapping (parent
 * handling, duration math, attribute sanitization) without an OTel provider.
 */
export function toSpanRow(span: ReadableSpan): SpanRow {
  const startTime = new Date(span.startTime[0] * 1000 + span.startTime[1] / 1_000_000);
  const endTime = new Date(span.endTime[0] * 1000 + span.endTime[1] / 1_000_000);
  const durationMs = Math.max(0, span.duration[0] * 1000 + span.duration[1] / 1_000_000);
  const { traceId, spanId } = span.spanContext();

  return {
    traceId,
    spanId,
    // ReadableSpan exposes the parent as a full SpanContext, not an id.
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: String(span.kind),
    startTime,
    endTime,
    durationMs: durationMs.toFixed(3),
    statusCode: span.status.code === 2 ? "error" : span.status.code === 1 ? "ok" : "unset",
    statusMessage: span.status.message ?? null,
    attributes: sanitizeAttributes(span.attributes),
  };
}

/** jsonb-safe: drops undefined, converts bigint/Date to strings, truncates long values. */
function sanitizeAttributes(attributes: ReadableSpan["attributes"]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Widened to unknown deliberately: this function's job is to accept whatever
  // an attribute value happens to be, including values the OTel types do not
  // describe (a BigInt token count, for example), and make them storable.
  for (const [key, value] of Object.entries(attributes) as [string, unknown][]) {
    if (value === undefined || value === null) continue;
    if (typeof value === "bigint") result[key] = value.toString();
    else if (value instanceof Date) result[key] = value.toISOString();
    else if (Array.isArray(value)) result[key] = value.map(String);
    else if (typeof value === "number" || typeof value === "boolean") result[key] = value;
    else result[key] = String(value).slice(0, 1000);
  }
  return result;
}

/**
 * Fails soft on purpose. Tracing is observability, not correctness: a database
 * hiccup must never take down an analysis run, so a failed write is logged and
 * dropped rather than thrown into the caller's stack.
 */
export function createPostgresSpanExporter(): SpanExporter {
  return {
    async export(spans: ReadableSpan[], resultCallback): Promise<void> {
      if (spans.length === 0) {
        resultCallback({ code: 0 });
        return;
      }
      try {
        await getDb()
          .insert(traceSpans)
          .values(spans.map(toSpanRow));
        resultCallback({ code: 0 });
      } catch (error) {
        getLogger().warn({ spanCount: spans.length, error }, "Failed to persist trace spans");
        resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
      }
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
  };
}

let provider: NodeTracerProvider | undefined;

/**
 * Registers the global tracer provider. No-ops when tracing is disabled or when
 * there is no database to write to — in that case spans are simply not
 * collected, and everything else still works.
 */
export function registerTracing(): NodeTracerProvider | undefined {
  if (provider) return provider;

  const env = observabilityEnv();
  if (!env.OTEL_ENABLED || !hasDatabaseConfig()) {
    getLogger().info(
      { otelEnabled: env.OTEL_ENABLED, databaseConfigured: hasDatabaseConfig() },
      "Tracing not started",
    );
    return undefined;
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor(createPostgresSpanExporter())],
  });
  provider.register();
  getLogger().info({ service: env.OTEL_SERVICE_NAME, exporter: "postgres" }, "Tracing started");
  return provider;
}
