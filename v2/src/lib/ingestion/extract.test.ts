import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  extractArchive,
  isSafeEntryPath,
  planExtraction,
} from "./extract";
import type { ArchiveEntry, ExtractionLimits } from "./extract";

const entry = (path: string, size = 100, compressedSize = 50): ArchiveEntry => ({
  path,
  size,
  compressedSize,
});

const limits = (overrides: Partial<ExtractionLimits> = {}): ExtractionLimits => ({
  ...DEFAULT_LIMITS,
  ...overrides,
});

describe("isSafeEntryPath", () => {
  it.each([
    ["src/main/App.java", true],
    ["a/b/c/d.txt", true],
    ["README.md", true],
    ["", false],
    ["/etc/passwd", false],
    ["../../etc/passwd", false],
    ["src/../../etc/passwd", false],
    ["..\\..\\windows\\system32", false],
    ["src\\main\\App.java", false],
    ["C:/Users/me/secrets.txt", false],
    ["c:secrets.txt", false],
    ["src//double.txt", false],
    ["has\0nul.txt", false],
  ])("%s → %s", (path, expected) => {
    expect(isSafeEntryPath(path)).toBe(expected);
  });
});

describe("planExtraction", () => {
  it("accepts an ordinary tree", () => {
    const plan = planExtraction([entry("src/a.ts"), entry("src/b.ts"), entry("README.md")]);
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(3);
  });

  it("rejects traversal without rejecting the rest of the archive", () => {
    const plan = planExtraction([entry("../../etc/passwd"), entry("src/a.ts")]);
    expect(plan.rejected).toEqual([{ path: "../../etc/passwd", reason: "unsafe-path" }]);
    expect(plan.accepted.map((item) => item.path)).toEqual(["src/a.ts"]);
  });

  it("rejects an entry over the per-file ceiling", () => {
    const plan = planExtraction([entry("huge.bin", 10 * 1024 * 1024)], limits({ maxEntryBytes: 1024 }));
    expect(plan.rejected).toEqual([{ path: "huge.bin", reason: "entry-too-large" }]);
  });

  it("rejects a zip-bomb-shaped entry by compression ratio", () => {
    // 5 MB uncompressed from 1 KB compressed is 5000:1 — a legitimate source file
    // never looks like this.
    const plan = planExtraction([entry("bomb.txt", 5 * 1024 * 1024, 1024)]);
    expect(plan.rejected).toEqual([{ path: "bomb.txt", reason: "suspicious-compression-ratio" }]);
  });

  it("allows a legitimately compressible but sane file", () => {
    const plan = planExtraction([entry("log.txt", 100_000, 5_000)]);
    expect(plan.rejected).toEqual([]);
  });

  it("stops accepting once the entry count is exceeded", () => {
    const plan = planExtraction(
      [entry("a.txt"), entry("b.txt"), entry("c.txt")],
      limits({ maxEntries: 2 }),
    );
    expect(plan.accepted).toHaveLength(2);
    expect(plan.rejected).toEqual([{ path: "c.txt", reason: "too-many-entries" }]);
  });

  it("stops accepting once the total size is exceeded", () => {
    const plan = planExtraction(
      [entry("a.txt", 800), entry("b.txt", 800)],
      limits({ maxTotalBytes: 1000 }),
    );
    expect(plan.accepted.map((item) => item.path)).toEqual(["a.txt"]);
    expect(plan.rejected).toEqual([{ path: "b.txt", reason: "total-size-exceeded" }]);
    expect(plan.totalBytes).toBe(800);
  });

  it("does not count directory entries as rejections", () => {
    // Archives routinely carry explicit directory entries; flagging them would
    // make every normal upload look suspicious.
    const plan = planExtraction([entry("src/", 0, 0), entry("src/a.ts")]);
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted.map((item) => item.path)).toEqual(["src/a.ts"]);
  });
});

describe("extractArchive", () => {
  it("round-trips a real archive", () => {
    const archive = zipSync({
      "src/app.ts": strToU8("export const x = 1;\n"),
      "nested/dir/spec.yaml": strToU8("openapi: 3.0.0\n"),
    });

    const result = extractArchive(archive);
    expect([...result.files.keys()].sort()).toEqual(["nested/dir/spec.yaml", "src/app.ts"]);
    expect(new TextDecoder().decode(result.files.get("src/app.ts"))).toContain("export const x = 1;");
    expect(result.rejected).toEqual([]);
  });

  it("applies the same limits it would have planned", () => {
    const archive = zipSync({
      "keep.ts": strToU8("const keep = true;"),
      "drop.bin": strToU8("y".repeat(4096)),
    });

    const result = extractArchive(archive, limits({ maxEntryBytes: 1024 }));
    expect([...result.files.keys()]).toEqual(["keep.ts"]);
    expect(result.rejected).toEqual([{ path: "drop.bin", reason: "entry-too-large" }]);
  });

  it("returns an empty result for an empty archive", () => {
    const result = extractArchive(zipSync({}));
    expect(result.files.size).toBe(0);
    expect(result.rejected).toEqual([]);
  });
});
