import { describe, expect, it } from "vitest";

import { createStubLlm } from "@/lib/llm/client";
import { DEFAULT_QUERY_COUNT, expandQuery, parseVariants } from "./multiQuery";

describe("parseVariants", () => {
  it("strips numbering and bullets", () => {
    expect(parseVariants("1. How does order lookup work?\n2) What reads the inventory table?", 2)).toEqual([
      "How does order lookup work?",
      "What reads the inventory table?",
    ]);
    expect(parseVariants("- How does order lookup work?", 1)).toEqual(["How does order lookup work?"]);
  });

  it("strips wrapping quotes and emphasis the model adds unbidden", () => {
    expect(parseVariants('"How does order lookup work?"', 1)).toEqual(["How does order lookup work?"]);
  });

  it("drops a preamble line ending in a colon", () => {
    expect(parseVariants("Here are the variants:\nHow does order lookup work?", 2)).toEqual([
      "How does order lookup work?",
    ]);
  });

  it("drops code fences", () => {
    expect(parseVariants("```\nHow does order lookup work?\n```", 2)).toEqual([
      "How does order lookup work?",
    ]);
  });

  it("deduplicates case-insensitively", () => {
    expect(parseVariants("How does order lookup work?\nhow does ORDER lookup work?", 2)).toEqual([
      "How does order lookup work?",
    ]);
  });

  it("caps at the requested count", () => {
    const response = Array.from({ length: 10 }, (_, index) => `Variant number ${index} about orders`).join("\n");
    expect(parseVariants(response, 3)).toHaveLength(3);
  });

  it("rejects fragments too short to be a query and prose too long to be one", () => {
    const tooShort = "orders";
    const tooLong = `What ${"really ".repeat(60)}happened?`;
    expect(parseVariants(`${tooShort}\n${tooLong}\nHow does order lookup work?`, 5)).toEqual([
      "How does order lookup work?",
    ]);
  });

  it("returns nothing for a null response", () => {
    expect(parseVariants(null, 3)).toEqual([]);
  });
});

describe("expandQuery", () => {
  it("always puts the original question first", async () => {
    const llm = createStubLlm(() => "How is order status resolved?\nWhere is order data stored?");
    const queries = await expandQuery("why is order lookup slow?", llm, { count: 3 });

    expect(queries[0]).toBe("why is order lookup slow?");
    expect(queries).toHaveLength(3);
  });

  it("searches once, with no model call, when only one query is wanted", async () => {
    let calls = 0;
    const llm = createStubLlm(() => {
      calls += 1;
      return "unused";
    });

    expect(await expandQuery("anything", llm, { count: 1 })).toEqual(["anything"]);
    expect(calls).toBe(0);
  });

  it("falls back to a single-query search when the model is unreachable", async () => {
    // Returning nothing because an auxiliary call failed would be a worse
    // outcome than returning the obvious results.
    const llm = createStubLlm(() => {
      throw new Error("upstream 503");
    });

    expect(await expandQuery("why is order lookup slow?", llm, { count: 3 })).toEqual([
      "why is order lookup slow?",
    ]);
  });

  it("falls back when the model returns only prose", async () => {
    const llm = createStubLlm(() => "I'm sorry, I can't help with that request without more context.");
    const queries = await expandQuery("why is order lookup slow?", llm, { count: 3 });
    expect(queries).toEqual(["why is order lookup slow?"]);
  });

  it("does not search the same query twice when the model echoes the question", async () => {
    const llm = createStubLlm(() => "why is order lookup slow?\nHow is order status resolved?");
    const queries = await expandQuery("why is order lookup slow?", llm, { count: 3 });

    expect(queries).toEqual(["why is order lookup slow?", "How is order status resolved?"]);
  });

  it("defaults to three queries", async () => {
    const llm = createStubLlm(() => "How is order status resolved?\nWhere is order data stored?");
    expect(await expandQuery("q", llm)).toHaveLength(DEFAULT_QUERY_COUNT);
  });
});
