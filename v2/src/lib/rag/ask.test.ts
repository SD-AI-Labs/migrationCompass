import { describe, expect, it } from "vitest";

import { createStubLlm } from "@/lib/llm/client";
import { askQuestion, askStreaming, buildContext } from "./ask";
import type { AskDeps } from "./ask";
import { toVectorLiteral } from "./retrieve";
import type { RetrievedChunk } from "./retrieve";

/**
 * The pipeline is asserted on its *shape*: which calls happen, how many times,
 * and what survives failure. Those are the properties that decide whether the
 * ask path is correct and affordable — and they are exactly the ones a
 * happy-path test would miss.
 */

const chunk = (id: string, similarity = 0.9): RetrievedChunk => ({
  id,
  source: `src/${id}.ts`,
  fileName: `${id}.ts`,
  documentType: "code",
  content: `body of ${id}`,
  similarity,
});

type Harness = {
  deps: AskDeps;
  calls: string[];
  retrievedFor: string[][];
  embeddedTexts: string[][];
};

function harness(options: {
  variants?: string;
  retrieval?: (queryIndex: number) => RetrievedChunk[];
  ranking?: string;
  answer?: string;
  expandThrows?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const retrievedFor: string[][] = [];
  const embeddedTexts: string[][] = [];
  // Counts retrieve() calls, so each query in a set gets distinct fixtures —
  // keyed off the embedding batch this would return the same set every time and
  // silently collapse the merge/de-dupe assertions.
  let retrieveCount = 0;

  const llm = createStubLlm((prompt) => {
    if (prompt.user.includes("semantically diverse")) {
      calls.push("expand");
      if (options.expandThrows) throw new Error("expansion unavailable");
      return options.variants ?? "Where is order data stored?\nWhich service reads inventory?";
    }
    if (prompt.user.includes("MOST relevant")) {
      calls.push("rerank");
      return options.ranking ?? "1";
    }
    calls.push("answer");
    return options.answer ?? "Order lookup is slow because of X.";
  });

  const deps: AskDeps = {
    llm,
    embed: async (texts) => {
      calls.push("embed");
      embeddedTexts.push([...texts]);
      return texts.map(() => [1, 0, 0]);
    },
    retrieve: async ({ queryEmbedding }) => {
      calls.push("retrieve");
      const index = retrieveCount;
      retrieveCount += 1;
      const results = options.retrieval ? options.retrieval(index) : [chunk(`c${index}`)];
      retrievedFor.push(results.map((item) => item.id));
      void queryEmbedding;
      return results;
    },
  };

  return { deps, calls, retrievedFor, embeddedTexts };
}

describe("askQuestion pipeline", () => {
  it("expands once, embeds the whole query set once, retrieves per query, reranks once, answers once", async () => {
    // Three distinct chunks per query, nine merged candidates, keepTop of four:
    // the candidate set has to exceed keepTop for reranking to be worth a call.
    const { deps, calls, embeddedTexts } = harness({
      retrieval: (index) => [chunk(`c${index}a`), chunk(`c${index}b`), chunk(`c${index}c`)],
    });

    await askQuestion({ question: "why is order lookup slow?", deps, keepTop: 4 });

    expect(calls.filter((call) => call === "expand")).toHaveLength(1);
    expect(calls.filter((call) => call === "embed")).toHaveLength(1);
    expect(calls.filter((call) => call === "retrieve")).toHaveLength(3);
    expect(calls.filter((call) => call === "rerank")).toHaveLength(1);
    expect(calls.filter((call) => call === "answer")).toHaveLength(1);

    // The embedding call carries the original plus both variants.
    expect(embeddedTexts[0]).toHaveLength(3);
    expect(embeddedTexts[0]?.[0]).toBe("why is order lookup slow?");
  });

  it("skips the reranking call when the merged candidate set already fits", async () => {
    const { deps, calls } = harness({ retrieval: (index) => [chunk(`c${index}`)] });
    const result = await askQuestion({ question: "q", deps });

    expect(calls).not.toContain("rerank");
    expect(result.candidatesUsed).toBe(3);
  });

  it("returns the original question first among the queries searched", async () => {
    const { deps } = harness();
    const result = await askQuestion({ question: "why is order lookup slow?", deps });
    expect(result.queries[0]).toBe("why is order lookup slow?");
  });

  it("de-duplicates chunks found by more than one query", async () => {
    // Overlapping retrievals are guaranteed, not exceptional: three queries about
    // one system will each surface the same core files.
    const { deps } = harness({ retrieval: () => [chunk("shared"), chunk("other")] });
    const result = await askQuestion({ question: "q", deps });

    expect(result.candidatesRetrieved).toBe(6);
    expect(result.candidatesUsed).toBe(2);
  });

  it("reports similarity per citation", async () => {
    const { deps } = harness({ retrieval: () => [chunk("a", 0.83)] });
    const result = await askQuestion({ question: "q", deps });

    expect(result.citations[0]?.similarity).toBeCloseTo(0.83);
    expect(result.citations[0]?.source).toBe("src/a.ts");
  });

  it("searches once and still answers when expansion is unavailable", async () => {
    const { deps, calls } = harness({ expandThrows: true });
    const result = await askQuestion({ question: "why is order lookup slow?", deps });

    expect(result.queries).toEqual(["why is order lookup slow?"]);
    expect(calls.filter((call) => call === "retrieve")).toHaveLength(1);
    expect(result.answer).toBe("Order lookup is slow because of X.");
  });

  it("still answers when nothing is retrieved", async () => {
    const { deps } = harness({ retrieval: () => [] });
    const result = await askQuestion({ question: "q", deps });

    expect(result.candidatesUsed).toBe(0);
    expect(result.citations).toEqual([]);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it("keeps only keepTop candidates after reranking", async () => {
    const { deps } = harness({ retrieval: () => [chunk("a"), chunk("b"), chunk("c")], ranking: "2,3" });
    const result = await askQuestion({ question: "q", deps, keepTop: 2 });

    expect(result.candidatesUsed).toBe(2);
  });
});

describe("askStreaming", () => {
  it("emits citations before any answer token", async () => {
    // The UI shows what is being read while the answer arrives, so the order of
    // these two events is a contract, not an implementation detail.
    const { deps } = harness();
    const events: string[] = [];
    for await (const event of askStreaming({ question: "q", deps })) events.push(event.type);

    expect(events[0]).toBe("citations");
    expect(events).toContain("delta");
    expect(events.at(-1)).toBe("done");
  });

  it("assembles the deltas into the final answer", async () => {
    const { deps } = harness({ answer: "Because of X and Y." });
    let assembled = "";
    let final = "";

    for await (const event of askStreaming({ question: "q", deps, queryCount: 1 })) {
      if (event.type === "delta") assembled += event.text;
      if (event.type === "done") final = event.answer;
    }

    expect(assembled).toBe("Because of X and Y.");
    expect(final).toBe(assembled);
  });
});

describe("buildContext", () => {
  it("numbers chunks and labels them with their source", () => {
    expect(buildContext([chunk("a")])).toContain("[1] src/a.ts");
  });

  it("says plainly when there is no context", () => {
    // The prompt must not present an empty context as though it were evidence.
    expect(buildContext([])).toContain("no relevant context");
  });
});

describe("toVectorLiteral", () => {
  it("formats a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("refuses an empty embedding", () => {
    expect(() => toVectorLiteral([])).toThrow(/empty embedding/);
  });

  it("refuses non-finite values", () => {
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/non-finite/);
    expect(() => toVectorLiteral([1, Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
  });
});
