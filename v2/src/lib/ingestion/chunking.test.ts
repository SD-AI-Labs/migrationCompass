import { describe, expect, it } from "vitest";

import {
  CODE_BUDGET,
  PROSE_BUDGET,
  budgetFor,
  chunkFile,
  chunkFiles,
  estimateTokens,
  kindOf,
  splitIntoChunks,
} from "./chunking";
import type { SourceFile } from "./chunking";

/** A document of `paragraphs` distinct paragraphs, each ~`charsPer` characters. */
function document(paragraphs: number, charsPer: number): string {
  return Array.from({ length: paragraphs }, (_, index) => {
    const body = `paragraph ${index} `.padEnd(charsPer, "x");
    return body;
  }).join("\n\n");
}

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("treats empty input as zero tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("budgets", () => {
  it("gives source code more room per chunk than prose", () => {
    // The whole point of the code-aware split: a boundary mid-method costs more
    // than a boundary mid-paragraph.
    expect(budgetFor("code").maxTokens).toBeGreaterThan(budgetFor("prose").maxTokens);
  });

  it("maps only code documents to the code budget", () => {
    expect(kindOf("code")).toBe("code");
    expect(kindOf("log")).toBe("prose");
    expect(kindOf("spec")).toBe("prose");
    expect(kindOf("doc")).toBe("prose");
  });
});

describe("splitIntoChunks", () => {
  it("returns nothing for whitespace-only input", () => {
    // An empty chunk embeds to a meaningless vector and becomes retrievable noise.
    expect(splitIntoChunks("   \n\n \t ", PROSE_BUDGET)).toEqual([]);
    expect(splitIntoChunks("", PROSE_BUDGET)).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = splitIntoChunks("A short spec paragraph.", PROSE_BUDGET);
    expect(chunks).toEqual(["A short spec paragraph."]);
  });

  it("respects the token ceiling for normal prose", () => {
    const chunks = splitIntoChunks(document(40, 400), PROSE_BUDGET);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Overlap is prepended to a chunk after the size check, so allow the
      // configured overlap on top of the ceiling for the seeded portion.
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(
        PROSE_BUDGET.maxTokens + PROSE_BUDGET.overlapTokens,
      );
    }
  });

  it("loses no content", () => {
    const source = document(40, 400);
    const chunks = splitIntoChunks(source, PROSE_BUDGET);
    for (const paragraph of source.split("\n\n")) {
      expect(chunks.some((chunk) => chunk.includes(paragraph.trim()))).toBe(true);
    }
  });

  it("overlaps consecutive chunks so a boundary does not sever a thought", () => {
    const chunks = splitIntoChunks(document(40, 400), PROSE_BUDGET);
    expect(chunks.length).toBeGreaterThan(1);
    const previousTailLine = chunks[0]?.split("\n").at(-1);
    expect(previousTailLine).toBeDefined();
    expect(chunks[1]).toContain(previousTailLine as string);
  });

  it("produces fewer chunks for code than prose at the same size", () => {
    const source = document(60, 400);
    expect(splitIntoChunks(source, CODE_BUDGET).length).toBeLessThan(
      splitIntoChunks(source, PROSE_BUDGET).length,
    );
  });

  it("hard-splits a single oversized line instead of emitting it whole", () => {
    // A minified bundle or one-line JSON blob: there is no boundary to split on,
    // so the split lands mid-line rather than producing one useless giant chunk.
    const chunks = splitIntoChunks("x".repeat(20_000), PROSE_BUDGET);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("merges a trailing sliver into its predecessor", () => {
    // Just over one chunk, with a tiny remainder: the remainder is not worth
    // its own chunk.
    const source = `${"a".repeat(3100)}\n\n${"b".repeat(50)}`;
    const chunks = splitIntoChunks(source, PROSE_BUDGET);
    expect(chunks.length).toBe(1);
  });
});

describe("chunkFile", () => {
  const file: SourceFile = {
    path: "src/main/java/Order.java",
    fileName: "Order.java",
    documentType: "code",
    content: "class Order {}\n\nclass Item {}",
  };

  it("numbers chunks sequentially within a file", () => {
    const chunks = chunkFile({ ...file, content: document(60, 400) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it("carries the citation metadata retrieval needs", () => {
    const [chunk] = chunkFile(file);
    expect(chunk?.source).toBe("src/main/java/Order.java");
    expect(chunk?.fileName).toBe("Order.java");
    expect(chunk?.documentType).toBe("code");
  });

  it("records a token count per chunk", () => {
    const [chunk] = chunkFile(file);
    expect(chunk?.tokenCount).toBe(estimateTokens(chunk?.content ?? ""));
  });

  it("produces no chunks for an empty file", () => {
    expect(chunkFile({ ...file, content: "\n\n" })).toEqual([]);
  });
});

describe("chunkFiles", () => {
  it("flattens chunks across files in order", () => {
    const files: SourceFile[] = [
      { path: "a.ts", fileName: "a.ts", documentType: "code", content: "const a = 1;" },
      { path: "b.ts", fileName: "b.ts", documentType: "code", content: "const b = 2;" },
    ];
    const chunks = chunkFiles(files);
    expect(chunks.map((chunk) => chunk.source)).toEqual(["a.ts", "b.ts"]);
  });
});
