import { describe, expect, it } from "vitest";

import { createStubLlm } from "@/lib/llm/client";
import { mergeCandidates, parseRanking, rerankCandidates } from "./rerank";
import type { RankableCandidate } from "./rerank";

const candidate = (id: string): RankableCandidate => ({
  id,
  source: `src/${id}.ts`,
  content: `content of ${id}`,
});

const candidates = (...ids: string[]): RankableCandidate[] => ids.map(candidate);

describe("parseRanking", () => {
  it("converts a 1-based list to 0-based indices", () => {
    expect(parseRanking("3,1,2", 3, 3)).toEqual([2, 0, 1]);
  });

  it("ignores out-of-range indices", () => {
    expect(parseRanking("9,2", 3, 3)).toEqual([1]);
  });

  it("ignores duplicates", () => {
    expect(parseRanking("2,2,1", 3, 3)).toEqual([1, 0]);
  });

  it("stops at keepTop", () => {
    expect(parseRanking("1,2,3,4", 4, 2)).toEqual([0, 1]);
  });

  it("returns null when nothing usable was found", () => {
    expect(parseRanking(null, 3, 3)).toBeNull();
    expect(parseRanking("I cannot rank these.", 3, 3)).toBeNull();
  });

  it("tolerates surrounding prose", () => {
    expect(parseRanking("Most relevant: 2, 1", 3, 3)).toEqual([1, 0]);
  });
});

describe("rerankCandidates", () => {
  it("orders and truncates by the model's ranking", async () => {
    const llm = createStubLlm(() => "3,1");
    const ranked = await rerankCandidates({
      question: "why is order lookup slow?",
      candidates: candidates("a", "b", "c", "d"),
      keepTop: 2,
      llm,
    });

    expect(ranked.map((item) => item.id)).toEqual(["c", "a"]);
  });

  it("skips the model call when the candidate set already fits", async () => {
    // Ranking cannot change which chunks are used at this size — only their
    // order — so the call would be a round-trip for nothing.
    let calls = 0;
    const llm = createStubLlm(() => {
      calls += 1;
      return "1,2";
    });

    const ranked = await rerankCandidates({
      question: "q",
      candidates: candidates("a", "b"),
      keepTop: 5,
      llm,
    });

    expect(calls).toBe(0);
    expect(ranked.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("fails open, returning the original list untruncated, when the model errors", async () => {
    const llm = createStubLlm(() => {
      throw new Error("upstream 500");
    });

    const input = candidates("a", "b", "c", "d");
    const ranked = await rerankCandidates({ question: "q", candidates: input, keepTop: 2, llm });

    // Untruncated on purpose: truncating by retrieval order would be pretending
    // to a judgement that was never made.
    expect(ranked).toHaveLength(4);
    expect(ranked.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("fails open when the response is unparseable", async () => {
    const llm = createStubLlm(() => "All of these look relevant to me.");
    const ranked = await rerankCandidates({
      question: "q",
      candidates: candidates("a", "b", "c"),
      keepTop: 1,
      llm,
    });

    expect(ranked).toHaveLength(3);
  });

  it("shows the model each candidate's source, not just its text", async () => {
    let prompt = "";
    const llm = createStubLlm((input) => {
      prompt = input.user;
      return "1,2";
    });

    await rerankCandidates({
      question: "q",
      candidates: candidates("a", "b", "c"),
      keepTop: 2,
      llm,
    });

    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("[1]");
  });

  it("truncates a long candidate before sending it to the model", async () => {
    let prompt = "";
    const llm = createStubLlm((input) => {
      prompt = input.user;
      return "1,2";
    });

    await rerankCandidates({
      question: "q",
      candidates: [
        { id: "a", source: "src/a.ts", content: "x".repeat(5000) },
        candidate("b"),
        candidate("c"),
      ],
      keepTop: 2,
      llm,
    });

    expect(prompt.length).toBeLessThan(1500);
  });
});

describe("mergeCandidates", () => {
  it("keeps the first occurrence of each id", () => {
    const merged = mergeCandidates([
      [candidate("a"), candidate("b")],
      [candidate("b"), candidate("c")],
    ]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the order of the query that found each chunk first", () => {
    // The first query is the user's literal question, so its results are the
    // most trustworthy ones to keep at the front before reranking.
    const merged = mergeCandidates([[candidate("first")], [candidate("second")]]);
    expect(merged.map((item) => item.id)).toEqual(["first", "second"]);
  });

  it("handles empty input", () => {
    expect(mergeCandidates([])).toEqual([]);
    expect(mergeCandidates([[], []])).toEqual([]);
  });
});
