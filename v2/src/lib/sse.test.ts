import { describe, expect, it } from "vitest";

import { drainSseEvents } from "./sse";

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

describe("drainSseEvents", () => {
  it("parses complete frames", () => {
    const { events, rest } = drainSseEvents(frame({ type: "delta", text: "hi" }));
    expect(events).toEqual([{ type: "delta", text: "hi" }]);
    expect(rest).toBe("");
  });

  it("keeps a half-written frame in the buffer", () => {
    // Chunk boundaries do not respect frame boundaries, so this is the normal
    // case rather than an edge case.
    const { events, rest } = drainSseEvents('data: {"type":"delta","text":"par');
    expect(events).toEqual([]);
    expect(rest).toBe('data: {"type":"delta","text":"par');
  });

  it("completes a frame split across two reads", () => {
    const first = drainSseEvents('data: {"type":"delta","text":"hel');
    const second = drainSseEvents(`${first.rest}lo"}\n\n`);
    expect(second.events).toEqual([{ type: "delta", text: "hello" }]);
  });

  it("parses several frames in one read", () => {
    const { events } = drainSseEvents(
      frame({ type: "delta", text: "a" }) + frame({ type: "delta", text: "b" }),
    );
    expect(events).toHaveLength(2);
  });

  it("ignores comments and non-data lines", () => {
    const { events } = drainSseEvents(`: keep-alive\n\n${frame({ type: "done" })}`);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("skips the [DONE] sentinel", () => {
    expect(drainSseEvents("data: [DONE]\n\n").events).toEqual([]);
  });

  it("drops a malformed frame without losing the rest", () => {
    const { events } = drainSseEvents(`data: {oops}\n\n${frame({ type: "done" })}`);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("returns nothing for an empty buffer", () => {
    expect(drainSseEvents("")).toEqual({ events: [], rest: "" });
  });
});
