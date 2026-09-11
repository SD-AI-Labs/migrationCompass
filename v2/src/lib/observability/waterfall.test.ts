import { describe, expect, it } from "vitest";

import { FIXTURE_TRACE_ID, fixtureTraceSpans } from "./fixture-trace";
import {
  MAX_WATERFALL_DEPTH,
  REDACTED,
  buildWaterfall,
  formatDuration,
  redactAttributes,
  type TraceSpanInput,
} from "./waterfall";

/**
 * The waterfall model, tested on structure rather than on one fixture's numbers.
 *
 * Trace data is messy in specific ways: rows arrive in flush order rather than tree
 * order, a parent can be missing because a different process wrote it, a duration can
 * disagree with its own timestamps, and a page that draws any of that without saying so
 * is worse than one that shows nothing. Each of those is a test here.
 */

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

function span(overrides: Partial<TraceSpanInput> & { spanId: string; offsetMs?: number }): TraceSpanInput {
  const offset = overrides.offsetMs ?? 0;
  const duration = typeof overrides.durationMs === "number" ? overrides.durationMs : 100;

  return {
    traceId: "trace-1",
    spanId: overrides.spanId,
    parentSpanId: overrides.parentSpanId ?? null,
    name: overrides.name ?? `span-${overrides.spanId}`,
    kind: overrides.kind ?? "internal",
    startTime: overrides.startTime ?? new Date(T0 + offset),
    endTime: overrides.endTime ?? new Date(T0 + offset + duration),
    durationMs: overrides.durationMs ?? duration,
    statusCode: overrides.statusCode ?? "unset",
    statusMessage: overrides.statusMessage ?? null,
    attributes: overrides.attributes ?? {},
  };
}

describe("waterfall construction", () => {
  it("nests children under their parent and orders depth-first", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "root", durationMs: 1000 }),
      span({ spanId: "a", parentSpanId: "root", offsetMs: 100, durationMs: 300 }),
      span({ spanId: "a1", parentSpanId: "a", offsetMs: 120, durationMs: 80 }),
      span({ spanId: "b", parentSpanId: "root", offsetMs: 500, durationMs: 200 }),
    ]);

    expect(waterfall.spanCount).toBe(4);
    expect(waterfall.roots.map((root) => root.spanId)).toEqual(["root"]);
    // Depth-first: the child of `a` sits between `a` and `b`, which is what a reader
    // expects a waterfall to read like.
    expect(waterfall.spans.map((s) => s.spanId)).toEqual(["root", "a", "a1", "b"]);
    expect(waterfall.spans.map((s) => s.depth)).toEqual([0, 1, 2, 1]);
    expect(waterfall.maxDepth).toBe(2);
    expect(waterfall.byId.get("a")?.children.map((child) => child.spanId)).toEqual(["a1"]);
  });

  it("computes durations, self time and offsets", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "root", durationMs: 1000 }),
      span({ spanId: "a", parentSpanId: "root", offsetMs: 100, durationMs: 300 }),
      span({ spanId: "b", parentSpanId: "root", offsetMs: 500, durationMs: 200 }),
    ]);

    const root = waterfall.byId.get("root");
    expect(waterfall.durationMs).toBe(1000);
    // Self time is duration minus the children's total: 1000 − (300 + 200).
    expect(root?.selfMs).toBe(500);
    expect(waterfall.byId.get("a")?.offsetMs).toBe(100);
    expect(waterfall.byId.get("b")?.offsetMs).toBe(500);
    // A leaf's self time is its whole duration.
    expect(waterfall.byId.get("b")?.selfMs).toBe(200);
  });

  it("places spans by parent links, so input order does not matter", () => {
    const ordered = buildWaterfall([
      span({ spanId: "root", durationMs: 900 }),
      span({ spanId: "child", parentSpanId: "root", offsetMs: 50, durationMs: 400 }),
      span({ spanId: "grandchild", parentSpanId: "child", offsetMs: 60, durationMs: 100 }),
    ]);
    // Reversed, which is also how a batch exporter flushes a trace.
    const outOfOrder = buildWaterfall([
      span({ spanId: "grandchild", parentSpanId: "child", offsetMs: 60, durationMs: 100 }),
      span({ spanId: "child", parentSpanId: "root", offsetMs: 50, durationMs: 400 }),
      span({ spanId: "root", durationMs: 900 }),
    ]);

    expect(outOfOrder.spans.map((s) => [s.spanId, s.depth])).toEqual(
      ordered.spans.map((s) => [s.spanId, s.depth]),
    );
    expect(outOfOrder.durationMs).toBe(ordered.durationMs);
  });

  it("shows an orphan span at the root and reports the trace as incomplete", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "root", durationMs: 1000 }),
      span({ spanId: "lonely", parentSpanId: "never-written", offsetMs: 10, durationMs: 20 }),
    ]);

    const orphan = waterfall.byId.get("lonely");
    expect(orphan?.orphan).toBe(true);
    expect(orphan?.depth).toBe(0);
    expect(orphan?.suspicious).toBe(true);
    expect(orphan?.issue).toMatch(/not in this trace/);
    expect(waterfall.orphans).toHaveLength(1);
    expect(waterfall.roots.map((root) => root.spanId).sort()).toEqual(["lonely", "root"]);
    expect(waterfall.issues.join(" ")).toMatch(/1 span\(s\) reference a parent that is not in this trace/);
  });

  it("survives deep nesting and truncates past the cap instead of hanging", () => {
    const spans: TraceSpanInput[] = [];
    for (let index = 0; index < MAX_WATERFALL_DEPTH + 12; index += 1) {
      spans.push(
        span({
          spanId: `level-${index}`,
          parentSpanId: index === 0 ? null : `level-${index - 1}`,
          offsetMs: index,
          durationMs: 100 - index,
        }),
      );
    }

    const waterfall = buildWaterfall(spans);

    expect(waterfall.maxDepth).toBe(MAX_WATERFALL_DEPTH);
    expect(waterfall.spanCount).toBe(MAX_WATERFALL_DEPTH + 1);
    expect(waterfall.issues.join(" ")).toMatch(/nests deeper than/);
  });

  it("re-roots a cycle rather than following it forever", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "a", parentSpanId: "b", durationMs: 100 }),
      span({ spanId: "b", parentSpanId: "a", offsetMs: 10, durationMs: 50 }),
    ]);

    expect(waterfall.spanCount).toBe(2);
    expect(waterfall.orphans.length).toBeGreaterThan(0);
    expect(waterfall.issues.join(" ")).toMatch(/returns to themselves \(a cycle\)/);
    expect(waterfall.orphans[0]?.issue).toMatch(/parent links returns to this span/);
  });

  it("skips unreadable rows with a reason instead of throwing", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "root", durationMs: 500 }),
      span({ spanId: "", name: "no id" }),
      { ...span({ spanId: "bad-time" }), startTime: "not a date", endTime: "also not a date" },
      span({ spanId: "root", name: "duplicate id" }),
    ]);

    expect(waterfall.spanCount).toBe(1);
    expect(waterfall.skipped).toHaveLength(3);
    expect(waterfall.skipped.map((entry) => entry.reason).join(" ")).toMatch(/no span id/);
    expect(waterfall.skipped.map((entry) => entry.reason).join(" ")).toMatch(/unparseable timestamp/);
    expect(waterfall.skipped.map((entry) => entry.reason).join(" ")).toMatch(/duplicate was dropped/);
  });

  it("recovers a missing duration from the timestamps and flags a disagreement", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "no-duration", durationMs: Number.NaN, offsetMs: 0, endTime: new Date(T0 + 250) }),
      span({ spanId: "liar", durationMs: 5000, offsetMs: 0, endTime: new Date(T0 + 100) }),
    ]);

    // The timestamps are ground truth; the stored duration is derived from them.
    expect(waterfall.byId.get("no-duration")?.durationMs).toBe(250);
    expect(waterfall.byId.get("liar")?.issue).toMatch(/disagrees with its timestamps/);
    expect(waterfall.byId.get("liar")?.suspicious).toBe(true);
  });

  it("returns an empty model for no spans, and for rows that cannot be read", () => {
    const empty = buildWaterfall([]);
    expect(empty.spanCount).toBe(0);
    expect(empty.durationMs).toBe(0);
    expect(empty.spans).toEqual([]);
    expect(empty.roots).toEqual([]);
    expect(empty.issues).toEqual([]);

    const unusable = buildWaterfall([{ ...span({ spanId: "" }), traceId: "t" }]);
    expect(unusable.spanCount).toBe(0);
    expect(unusable.issues.join(" ")).toMatch(/could be read as spans/);
  });

  it("is deterministic, including the order spans are returned in", () => {
    const spans = fixtureTraceSpans();
    const first = buildWaterfall(spans);
    const second = buildWaterfall([...spans].reverse());

    expect(second.spans.map((span) => span.spanId)).toEqual(first.spans.map((span) => span.spanId));
    expect(second.durationMs).toBe(first.durationMs);
    expect(second.maxDepth).toBe(first.maxDepth);
    // Two identical builds are byte-identical models, which is what makes the fixture
    // screenshot-able and the page cacheable.
    expect(JSON.stringify(buildWaterfall(spans))).toBe(JSON.stringify(first));
  });

  it("reads the trace id from the rows, whatever order they arrive in", () => {
    const waterfall = buildWaterfall([
      span({ spanId: "b", parentSpanId: "a" }),
      { ...span({ spanId: "a" }), traceId: FIXTURE_TRACE_ID },
    ]);

    expect(waterfall.traceId).toBe("trace-1");
    expect(buildWaterfall([{ ...span({ spanId: "a" }), traceId: "only" }]).traceId).toBe("only");
  });
});

describe("attribute redaction", () => {
  it("withholds credential-shaped keys and reports which ones", () => {
    const { attributes, redacted } = redactAttributes({
      "llm.model": "deepseek-chat",
      authorization: "Bearer sk-abcdefghijklmnop",
      apiKey: "sk-abcdefghijklmnop",
      "http.request.header.cookie": "mc_owner=abc",
      service: "migration-compass",
    });

    expect(attributes["llm.model"]).toBe("deepseek-chat");
    expect(attributes.service).toBe("migration-compass");
    expect(attributes.authorization).toBe(REDACTED);
    expect(attributes.apiKey).toBe(REDACTED);
    expect(attributes["http.request.header.cookie"]).toBe(REDACTED);
    expect(redacted.sort()).toEqual(["apiKey", "authorization", "http.request.header.cookie"]);
  });

  it("withholds a credential-shaped value even under an innocent key", () => {
    const { attributes, redacted } = redactAttributes({ note: "called with Bearer sk-live-abcdefghijk" });

    expect(attributes.note).toBe(REDACTED);
    expect(redacted).toContain("note");
  });

  it("redacts inside nested objects, and truncates very long values", () => {
    const { attributes } = redactAttributes({
      request: { headers: { authorization: "Bearer sk-abcdefghij" }, url: "https://example.test/health" },
      log: "x".repeat(900),
    });

    expect((attributes.request as Record<string, Record<string, unknown>>).headers?.authorization).toBe(REDACTED);
    expect((attributes.request as Record<string, string>).url).toBe("https://example.test/health");
    expect(String(attributes.log).length).toBeLessThan(600);
  });

  it("keeps the fixture's credentials out of the built model entirely", () => {
    // The last line of defence, asserted on the whole serialized model: nothing that
    // looks like a key, a bearer token or a session secret may survive construction.
    const serialized = JSON.stringify(buildWaterfall(fixtureTraceSpans()));

    expect(serialized).not.toMatch(/sk-fixture/);
    expect(serialized).not.toMatch(/fixture-session-token/);
    expect(serialized).not.toMatch(/fixture-password/);
    expect(serialized).not.toMatch(/cookie=fixture-session/);
    expect(serialized).not.toMatch(/Bearer /);
    expect(serialized).toContain(REDACTED);
  });
});

describe("duration formatting", () => {
  it("formats milliseconds, seconds and minutes deterministically", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(38)).toBe("38ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(18_420)).toBe("18.4s");
    expect(formatDuration(123_000)).toBe("2m 03s");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("the fixture trace", () => {
  it("exercises nesting, an orphan, out-of-order input and an error span", () => {
    const waterfall = buildWaterfall(fixtureTraceSpans());

    expect(waterfall.traceId).toBe(FIXTURE_TRACE_ID);
    expect(waterfall.spanCount).toBe(16);
    expect(waterfall.maxDepth).toBe(3);
    expect(waterfall.orphans).toHaveLength(1);
    expect(waterfall.orphans[0]?.name).toBe("agent.critique");
    expect(waterfall.issues.join(" ")).toMatch(/incomplete/);

    const errors = waterfall.spans.filter((span) => span.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe("rag.retrieve");
    expect(errors[0]?.statusMessage).toBe("context deadline exceeded");

    // The root's children are the three agents plus persistence and the flush, in start
    // order — the structure the page draws.
    const root = waterfall.byId.get("b7ad6b7169203331");
    expect(root?.children.map((child) => child.name)).toEqual([
      "agent.discovery",
      "agent.architecture",
      "agent.risk",
      "agent.comparison",
      "db.persistFindings",
      "span.flush",
    ]);
    // Self time on the root is the run minus the stages it contains.
    expect(root?.selfMs).toBeGreaterThan(0);
    expect(waterfall.durationMs).toBe(19_600);
  });

  it("is rendered deterministically, with the identity attributes the page shows", () => {
    const waterfall = buildWaterfall(fixtureTraceSpans());
    const root = waterfall.byId.get("b7ad6b7169203331");

    expect(root?.attributes["project.id"]).toBe("bb6b9238-02f7-461b-9f3f-e718c1ff8389");
    expect(root?.attributes["run.id"]).toBe("7b2eaba2-e595-4c8b-91af-fac415b36e05");
    expect(root?.attributes["project.name"]).toBe("sample-legacy-api.zip");
  });
});
