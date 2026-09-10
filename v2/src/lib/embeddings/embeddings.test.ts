import { describe, expect, it } from "vitest";

import { embedInBatches, createOllamaEmbeddings, createStubEmbeddings } from "./embeddings";

describe("createStubEmbeddings", () => {
  it("is deterministic", async () => {
    const provider = createStubEmbeddings(16);
    const [first] = await provider.embed(["inventory check service"]);
    const [second] = await provider.embed(["inventory check service"]);
    expect(first).toEqual(second);
  });

  it("produces unit-length vectors", async () => {
    const provider = createStubEmbeddings(16);
    const [vector] = await provider.embed(["order lookup service handles order status"]);
    const norm = Math.sqrt((vector ?? []).reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("places overlapping texts closer together than unrelated ones", async () => {
    // Structure is the point of the stub: retrieval tests must behave like
    // retrieval, not like a random number generator.
    const provider = createStubEmbeddings(64);
    const [a, b, c] = await provider.embed([
      "order lookup service handles order status queries",
      "order lookup service handles order history",
      "payment gateway idempotency key missing",
    ]);

    const cosine = (left: number[], right: number[]): number =>
      left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

    expect(cosine(a ?? [], b ?? [])).toBeGreaterThan(cosine(a ?? [], c ?? []));
  });

  it("handles an empty batch", async () => {
    expect(await createStubEmbeddings(4).embed([])).toEqual([]);
  });
});

describe("embedInBatches", () => {
  it("preserves order across batch boundaries", async () => {
    const provider = createStubEmbeddings(4);
    const texts = ["one", "two", "three", "four", "five"];
    const batched = await embedInBatches(provider, texts, 2);
    const whole = await provider.embed(texts);
    expect(batched).toEqual(whole);
  });

  it("returns nothing for no input", async () => {
    expect(await embedInBatches(createStubEmbeddings(4), [])).toEqual([]);
  });
});

describe("createOllamaEmbeddings", () => {
  it("reports the configured model as its name", () => {
    // Reads env with defaults, so this must not require Ollama to be running.
    const provider = createOllamaEmbeddings();
    expect(provider.name).toBe("ollama:nomic-embed-text");
    expect(provider.dimensions).toBe(768);
  });
});
