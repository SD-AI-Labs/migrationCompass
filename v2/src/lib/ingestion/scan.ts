import type { SourceFile } from "./chunking";

/**
 * Turns extracted archive bytes into the text files worth indexing.
 *
 * Two rules here are not stylistic:
 *
 * 1. **The extension allowlist is required, not a nicety.** Embedding a compiled
 *    binary or a font produces vectors that match nothing and dilute retrieval.
 * 2. **`ground-truth/` is excluded, always.** For the bundled example project the
 *    repository ships a hand-written expert analysis of the same system. If that
 *    text reaches the vector store, the analysis pipeline can retrieve the
 *    answer it is supposed to be graded against — the pipeline would look
 *    accurate and be worthless. V1 logged a warning when this happened; here it
 *    is a filtering rule with a test, and the count is reported back so a
 *    regression is visible instead of silent.
 */

/** Extensions whose contents are text worth embedding. */
export const ALLOWED_EXTENSIONS = new Set([
  "java", "py", "js", "jsx", "ts", "tsx", "go", "rb", "cs", "kt", "rs", "php", "c", "cpp", "h", "scala", "swift",
  "xml", "yaml", "yml", "json", "wsdl", "sql",
  "md", "txt", "log", "out", "properties", "gradle", "toml", "ini", "conf",
]);

const CODE_EXTENSIONS = new Set([
  "java", "py", "js", "jsx", "ts", "tsx", "go", "rb", "cs", "kt", "rs", "php", "c", "cpp", "h", "scala", "swift",
]);
const SPEC_EXTENSIONS = new Set(["xml", "yaml", "yml", "json", "wsdl"]);
const SCHEMA_EXTENSIONS = new Set(["sql"]);
const LOG_EXTENSIONS = new Set(["log", "out"]);

/** Directories never indexed, anywhere in any archive. */
export const EXCLUDED_DIRECTORY_SEGMENTS = new Set(["ground-truth", "node_modules", ".git", "target", "build", "dist"]);

/** Top-level directories indexed when loading the bundled example (which also contains its own ground truth). */
export const EXAMPLE_INCLUDED_TOP_LEVEL_DIRS = new Set([
  "source-code", "api-specs", "operational-data", "database", "logs",
]);

export type DocumentType = "code" | "spec" | "schema" | "doc" | "log";

export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function classifyDocumentType(fileName: string): DocumentType | null {
  const extension = extensionOf(fileName);
  if (extension === null || !ALLOWED_EXTENSIONS.has(extension)) return null;
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (SPEC_EXTENSIONS.has(extension)) return "spec";
  if (SCHEMA_EXTENSIONS.has(extension)) return "schema";
  if (LOG_EXTENSIONS.has(extension)) return "log";
  return "doc";
}

/**
 * Decodes UTF-8 text, returning null for anything that is not really text.
 * A NUL byte is the giveaway: it appears in compiled artefacts and images but
 * not in source, and decoding those would produce a chunk of replacement
 * characters that embeds to noise.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.some((byte) => byte === 0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export type SkippedFile = { path: string; reason: "excluded-directory" | "unsupported-extension" | "binary" | "empty" };

export type ScanOptions = {
  /** When set, only paths whose first segment is in this set are considered. */
  includeTopLevelDirs?: ReadonlySet<string>;
};

export type ScanResult = {
  sources: SourceFile[];
  skipped: SkippedFile[];
  /** Counted separately because a non-zero value here is a bug, not a preference. */
  excludedGroundTruthCount: number;
};

export function scanFiles(
  files: Map<string, Uint8Array>,
  options: ScanOptions = {},
): ScanResult {
  const sources: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  let excludedGroundTruthCount = 0;

  // Sorted so chunk order (and therefore anything derived from it) is
  // reproducible run to run — archive entry order is not stable across tools.
  const paths = [...files.keys()].sort();

  for (const path of paths) {
    const segments = path.split("/");
    const fileName = segments[segments.length - 1] ?? path;

    if (segments.some((segment) => EXCLUDED_DIRECTORY_SEGMENTS.has(segment))) {
      if (segments.includes("ground-truth")) excludedGroundTruthCount += 1;
      skipped.push({ path, reason: "excluded-directory" });
      continue;
    }

    if (options.includeTopLevelDirs && !options.includeTopLevelDirs.has(segments[0] ?? "")) {
      skipped.push({ path, reason: "excluded-directory" });
      continue;
    }

    const documentType = classifyDocumentType(fileName);
    if (documentType === null) {
      skipped.push({ path, reason: "unsupported-extension" });
      continue;
    }

    const bytes = files.get(path);
    if (!bytes || bytes.length === 0) {
      skipped.push({ path, reason: "empty" });
      continue;
    }

    const content = decodeText(bytes);
    if (content === null) {
      skipped.push({ path, reason: "binary" });
      continue;
    }

    if (content.trim().length === 0) {
      skipped.push({ path, reason: "empty" });
      continue;
    }

    sources.push({ path, fileName, documentType, content });
  }

  return { sources, skipped, excludedGroundTruthCount };
}
