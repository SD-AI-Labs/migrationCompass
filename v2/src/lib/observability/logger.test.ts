import { describe, expect, it } from "vitest";

import { spanContextFor } from "./logger";

const spanWith = (traceId: string, spanId: string) => ({
  spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
});

describe("spanContextFor", () => {
  it("returns nothing when there is no active span", () => {
    expect(spanContextFor(undefined)).toEqual({});
  });

  it("returns the trace and span ids of the active span", () => {
    expect(spanContextFor(spanWith("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"))).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
  });

  it("treats an all-zero (invalid) trace id as no context", () => {
    // OTel uses the zero id for a non-recording/invalid context. Emitting it
    // would produce log lines that point at a trace which does not exist.
    expect(spanContextFor(spanWith("", "00f067aa0ba902b7"))).toEqual({});
  });
});
