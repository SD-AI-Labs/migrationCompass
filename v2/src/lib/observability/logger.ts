import { trace, type Span } from "@opentelemetry/api";
import pino, { type Logger as PinoLogger } from "pino";

import { observabilityEnv } from "@/lib/env";

/**
 * pino with the active OTel trace id injected into every line.
 *
 * This is the plan's tracing story in one file: `trace.getActiveSpan()` reads
 * whatever span context is current, so the same id that identifies a trace in
 * `trace_spans` also tags every log line emitted while handling it. There is no
 * separate correlation-id mechanism, and nothing MDC-shaped to propagate across
 * thread boundaries by hand — the context is ambient or it isn't there.
 */

/**
 * Trace/span ids for the active span. Pure and exported on its own so the
 * "logs carry the trace id" claim is testable without capturing stdout.
 */
export function spanContextFor(span: Pick<Span, "spanContext"> | undefined): Record<string, string> {
  if (!span) return {};
  const context = span.spanContext();
  if (!context.traceId) return {};
  return { traceId: context.traceId, spanId: context.spanId };
}

let cached: PinoLogger | undefined;

function buildLogger(): PinoLogger {
  const env = observabilityEnv();
  return pino({
    level: env.LOG_LEVEL,
    base: { service: env.OTEL_SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: () => spanContextFor(trace.getActiveSpan()),
    redact: {
      // Uploaded source and any model payloads are user content; log line counts
      // and references, never bodies.
      paths: ["content", "prompt", "completion", "apiKey"],
      remove: true,
    },
  });
}

/**
 * Lazy so that importing a module which happens to log does not construct a
 * logger (and read env) at import time — keeps the pure module graph pure.
 */
export function getLogger(): PinoLogger {
  cached ??= buildLogger();
  return cached;
}

export type Logger = PinoLogger;
