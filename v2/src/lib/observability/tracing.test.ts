import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { toSpanRow } from "./tracing";

/**
 * toSpanRow is the only non-trivial logic in the tracing layer, so it is the
 * part worth testing: OTel's hi-res time representation, duration math, and the
 * conversion of arbitrary attribute values into jsonb-safe ones.
 */

function fakeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "agent.discovery",
    kind: 1,
    spanContext: () => ({ traceId: "trace-1", spanId: "span-1", traceFlags: 1 }),
    parentSpanContext: undefined,
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_001, 0],
    duration: [1, 0],
    status: { code: 0 },
    attributes: {},
    ...overrides,
  } as unknown as ReadableSpan;
}

const spanContextWithId = (spanId: string) => ({ traceId: "trace-1", spanId, traceFlags: 1 });

describe("toSpanRow", () => {
  it("converts OTel hi-res timestamps into dates", () => {
    const row = toSpanRow(fakeSpan());
    expect(row.startTime.getTime()).toBe(1_700_000_000_000);
    expect(row.endTime.getTime()).toBe(1_700_000_001_000);
  });

  it("expresses duration in milliseconds with sub-millisecond precision", () => {
    const row = toSpanRow(fakeSpan({ duration: [0, 1_500_000] }));
    expect(row.durationMs).toBe("1.500");
  });

  it("never reports a negative duration", () => {
    const row = toSpanRow(fakeSpan({ duration: [-1, 0] }));
    expect(row.durationMs).toBe("0.000");
  });

  it("records a root span as having no parent", () => {
    expect(toSpanRow(fakeSpan()).parentSpanId).toBeNull();
  });

  it("preserves the parent span id for a child span", () => {
    const child = fakeSpan({ parentSpanContext: spanContextWithId("span-0") });
    expect(toSpanRow(child).parentSpanId).toBe("span-0");
  });

  it("maps OTel status codes onto readable values", () => {
    expect(toSpanRow(fakeSpan({ status: { code: 0 } })).statusCode).toBe("unset");
    expect(toSpanRow(fakeSpan({ status: { code: 1 } })).statusCode).toBe("ok");
    expect(toSpanRow(fakeSpan({ status: { code: 2 } })).statusCode).toBe("error");
  });

  it("carries the error message through for failed spans", () => {
    const row = toSpanRow(fakeSpan({ status: { code: 2, message: "model returned 429" } }));
    expect(row.statusMessage).toBe("model returned 429");
  });

  it("makes attributes jsonb-safe", () => {
    const row = toSpanRow(
      fakeSpan({
        attributes: {
          "llm.token.count": 1234,
          "llm.cached": true,
          "run.id": 9007199254740993n,
          "query.chunks": ["a", "b"],
          missing: undefined,
          "prompt.text": "x".repeat(2000),
        },
      } as unknown as Partial<ReadableSpan>),
    );

    expect(row.attributes["llm.token.count"]).toBe(1234);
    expect(row.attributes["llm.cached"]).toBe(true);
    expect(row.attributes["run.id"]).toBe("9007199254740993");
    expect(row.attributes["query.chunks"]).toEqual(["a", "b"]);
    expect(row.attributes).not.toHaveProperty("missing");
    expect(String(row.attributes["prompt.text"])).toHaveLength(1000);
  });
});
