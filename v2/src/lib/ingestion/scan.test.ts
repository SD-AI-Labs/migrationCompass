import { describe, expect, it } from "vitest";

import {
  EXAMPLE_INCLUDED_TOP_LEVEL_DIRS,
  classifyDocumentType,
  decodeText,
  extensionOf,
  scanFiles,
} from "./scan";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const archive = (entries: Record<string, string | Uint8Array>): Map<string, Uint8Array> =>
  new Map(
    Object.entries(entries).map(([path, value]) => [
      path,
      typeof value === "string" ? encode(value) : value,
    ]),
  );

describe("extensionOf", () => {
  it("lower-cases the extension", () => {
    expect(extensionOf("App.JAVA")).toBe("java");
  });

  it("returns null for a file with no extension", () => {
    expect(extensionOf("Makefile")).toBeNull();
  });

  it("returns null for a dotfile-style trailing dot", () => {
    expect(extensionOf("weird.")).toBeNull();
  });
});

describe("classifyDocumentType", () => {
  it.each([
    ["App.java", "code"],
    ["main.ts", "code"],
    ["service.py", "code"],
    ["openapi.yaml", "spec"],
    ["schema.sql", "schema"],
    ["README.md", "doc"],
    ["app.log", "log"],
  ])("%s → %s", (fileName, expected) => {
    expect(classifyDocumentType(fileName)).toBe(expected);
  });

  it("rejects an extension that is not worth embedding", () => {
    expect(classifyDocumentType("libfoo.so")).toBeNull();
    expect(classifyDocumentType("font.woff2")).toBeNull();
    expect(classifyDocumentType("archive.zip")).toBeNull();
  });
});

describe("decodeText", () => {
  it("decodes UTF-8", () => {
    expect(decodeText(encode("héllo wörld"))).toBe("héllo wörld");
  });

  it("refuses binary content", () => {
    // A NUL byte is the giveaway for compiled artefacts and images.
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x00, 0x47]))).toBeNull();
  });
});

describe("scanFiles", () => {
  it("selects supported text files", () => {
    const result = scanFiles(
      archive({ "src/App.java": "class App {}", "spec.yaml": "openapi: 3.0.0", "README.md": "# Hi" }),
    );
    expect(result.sources.map((file) => file.path)).toEqual(["README.md", "spec.yaml", "src/App.java"]);
    expect(result.sources.find((file) => file.path === "src/App.java")?.documentType).toBe("code");
  });

  it("skips unsupported extensions", () => {
    const result = scanFiles(archive({ "lib.jar": "binary-ish" }));
    expect(result.sources).toEqual([]);
    expect(result.skipped).toEqual([{ path: "lib.jar", reason: "unsupported-extension" }]);
  });

  it("skips binary content even when the extension is allowed", () => {
    const result = scanFiles(archive({ "notes.txt": new Uint8Array([0x00, 0x01, 0x02]) }));
    expect(result.sources).toEqual([]);
    expect(result.skipped).toEqual([{ path: "notes.txt", reason: "binary" }]);
  });

  it("skips empty files", () => {
    const result = scanFiles(archive({ "empty.md": "   \n  " }));
    expect(result.skipped).toEqual([{ path: "empty.md", reason: "empty" }]);
  });

  it("never indexes ground truth, and reports how much it excluded", () => {
    // This is the one exclusion that would silently invalidate the whole
    // analysis if it regressed: the hand-written expert answer would be
    // retrievable by the pipeline being graded against it.
    const result = scanFiles(
      archive({
        "source-code/App.java": "class App {}",
        "ground-truth/architecture-overview.md": "# The real answer",
        "ground-truth/nested/dependency-graph.md": "# Also the real answer",
      }),
    );

    expect(result.sources.map((file) => file.path)).toEqual(["source-code/App.java"]);
    expect(result.excludedGroundTruthCount).toBe(2);
  });

  it("never indexes dependency directories", () => {
    const result = scanFiles(
      archive({
        "src/index.ts": "export {}",
        "node_modules/pkg/index.js": "module.exports = {}",
        ".git/config": "[core]",
        "build/output.js": "compiled",
      }),
    );
    expect(result.sources.map((file) => file.path)).toEqual(["src/index.ts"]);
  });

  it("restricts to the example's include list when asked", () => {
    const result = scanFiles(
      archive({
        "source-code/App.java": "class App {}",
        "database/schema.sql": "create table t();",
        "secrets/env.production.txt": "API_KEY=...",
      }),
      { includeTopLevelDirs: EXAMPLE_INCLUDED_TOP_LEVEL_DIRS },
    );
    expect(result.sources.map((file) => file.path)).toEqual(["database/schema.sql", "source-code/App.java"]);
  });

  it("returns files in a stable order regardless of archive entry order", () => {
    const first = scanFiles(archive({ "b.ts": "b", "a.ts": "a", "c.ts": "c" }));
    const second = scanFiles(archive({ "c.ts": "c", "a.ts": "a", "b.ts": "b" }));
    expect(first.sources.map((file) => file.path)).toEqual(second.sources.map((file) => file.path));
  });
});
