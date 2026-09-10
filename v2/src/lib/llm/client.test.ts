import { describe, expect, it } from "vitest";

import { createStubLlm, parseOpenAiSse } from "./client";

const encoder = new TextEncoder();

const frames = (payloads: unknown[]): string =>
  payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");

const delta = (content: string) => ({ choices: [{ delta: { content } }] });

async function* asChunks(parts: string[]): AsyncIterable<string> {
  for (const part of parts) yield part;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = [];
  for await (const item of source) collected.push(item);
  return collected;
}

describe("parseOpenAiSse", () => {
  it("yields each delta", async () => {
    const stream = asChunks([frames([delta("Good "), delta("question")])]);
    expect(await collect(parseOpenAiSse(stream))).toEqual(["Good ", "question"]);
  });

  it("reassembles an event split across network chunk boundaries", async () => {
    // The failure this guards: a chunk boundary landing mid-line. A naive
    // per-chunk split drops the token, intermittently and only under load.
    const payload = frames([delta("recalculateLoyaltyPoints")]);
    const parts = [payload.slice(0, 12), payload.slice(12, 30), payload.slice(30)];

    expect(await collect(parseOpenAiSse(asChunks(parts)))).toEqual(["recalculateLoyaltyPoints"]);
  });

  it("stops at the [DONE] sentinel", async () => {
    const stream = asChunks([frames([delta("first")]) + "data: [DONE]\n\n" + frames([delta("after")])]);
    expect(await collect(parseOpenAiSse(stream))).toEqual(["first"]);
  });

  it("skips malformed events without aborting the stream", async () => {
    const stream = asChunks(["data: {not json}\n\n", frames([delta("still fine")])]);
    expect(await collect(parseOpenAiSse(stream))).toEqual(["still fine"]);
  });

  it("ignores keep-alive and non-data lines", async () => {
    const stream = asChunks([": ping\n\n", "event: message\n", frames([delta("value")])]);
    expect(await collect(parseOpenAiSse(stream))).toEqual(["value"]);
  });

  it("handles a byte-chunked stream", async () => {
    const payload = encoder.encode(frames([delta("héllo")]));
    async function* bytes(): AsyncIterable<Uint8Array> {
      yield payload;
    }
    expect(await collect(parseOpenAiSse(bytes()))).toEqual(["héllo"]);
  });

  it("yields nothing for an empty stream", async () => {
    expect(await collect(parseOpenAiSse(asChunks([])))).toEqual([]);
  });
});

describe("createStubLlm", () => {
  it("answers complete() with the scripted text", async () => {
    const llm = createStubLlm(() => "scripted");
    expect(await llm.complete({ user: "anything" })).toBe("scripted");
  });

  it("streams in more than one delta", async () => {
    // Callers that accumulate deltas should be exercised, not handed one blob.
    const llm = createStubLlm(() => "x".repeat(100));
    const deltas = await collect(llm.stream({ user: "anything" }));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("x".repeat(100));
  });
});
