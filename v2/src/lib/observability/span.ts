import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

import { observabilityEnv } from "@/lib/env";

/**
 * Wraps an operation in a span. The point of having this rather than calling the
 * API directly at each site: spans carry the run id and project id as
 * attributes, so a trace waterfall can be filtered to one analysis run — and the
 * active span's id is what the logger injects into every line emitted inside.
 *
 * When tracing is disabled no provider is registered and these are no-op spans,
 * so this is safe to use unconditionally.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(observabilityEnv().OTEL_SERVICE_NAME);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
