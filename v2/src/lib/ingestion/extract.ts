import { unzipSync } from "fflate";

/**
 * Archive extraction with the guards that matter for a service that unpacks
 * whatever a visitor uploads.
 *
 * Three distinct classes of problem, all enforced before any bytes are inflated:
 *
 * 1. Path traversal — `../../etc/passwd`, absolute paths, and Windows-style
 *    separators smuggling a `..` past a POSIX-only check.
 * 2. Resource exhaustion — a small archive that expands to gigabytes (zip bomb),
 *    detected via declared sizes and a compression-ratio ceiling.
 * 3. Entry-count floods — a million empty files, each individually harmless.
 *
 * The decision logic (`evaluate`) is pure and shared between the plan-ahead path
 * used in tests and the filter callback fflate runs during decompression, so the
 * two can never drift apart.
 */

export type ExtractionLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Uncompressed:compressed ceiling for a single entry. */
  maxCompressionRatio: number;
};

export const DEFAULT_LIMITS: ExtractionLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export type ArchiveEntry = {
  path: string;
  /** Uncompressed size, from the archive's central directory. */
  size: number;
  compressedSize: number;
};

export type RejectionReason =
  | "unsafe-path"
  | "entry-too-large"
  | "suspicious-compression-ratio"
  | "too-many-entries"
  | "total-size-exceeded"
  | "directory-entry";

export type Rejection = { path: string; reason: RejectionReason };

export type ExtractionPlan = {
  accepted: ArchiveEntry[];
  rejected: Rejection[];
  totalBytes: number;
};

/**
 * Rejects anything that could escape the extraction root or confuse a later
 * consumer about where a file came from.
 */
export function isSafeEntryPath(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes("\0")) return false;
  // Windows separators are rejected outright rather than normalized: normalizing
  // would silently reinterpret `..\..\x` as a traversal, and rejecting is a
  // clear, auditable rule.
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  // A drive letter (C:) or UNC prefix in an archive entry is never legitimate.
  if (/^[a-zA-Z]:/.test(name)) return false;

  const segments = name.split("/");
  if (segments.some((segment) => segment === "..")) return false;
  if (segments.some((segment) => segment.length === 0)) return false;

  return true;
}

type RunningState = { acceptedCount: number; totalBytes: number };

/**
 * The single decision point. Returns a rejection, or null to accept — mutating
 * the running state only on acceptance, so the totals reflect what was kept.
 */
function evaluate(entry: ArchiveEntry, state: RunningState, limits: ExtractionLimits): Rejection | null {
  if (entry.path.endsWith("/")) return { path: entry.path, reason: "directory-entry" };
  if (!isSafeEntryPath(entry.path)) return { path: entry.path, reason: "unsafe-path" };
  if (entry.size > limits.maxEntryBytes) return { path: entry.path, reason: "entry-too-large" };

  if (entry.compressedSize > 0 && entry.size / entry.compressedSize > limits.maxCompressionRatio) {
    return { path: entry.path, reason: "suspicious-compression-ratio" };
  }

  if (state.acceptedCount + 1 > limits.maxEntries) {
    return { path: entry.path, reason: "too-many-entries" };
  }

  if (state.totalBytes + entry.size > limits.maxTotalBytes) {
    return { path: entry.path, reason: "total-size-exceeded" };
  }

  state.acceptedCount += 1;
  state.totalBytes += entry.size;
  return null;
}

/** Plan-only variant: decide what would be accepted without decompressing anything. */
export function planExtraction(
  entries: ArchiveEntry[],
  limits: ExtractionLimits = DEFAULT_LIMITS,
): ExtractionPlan {
  const state: RunningState = { acceptedCount: 0, totalBytes: 0 };
  const accepted: ArchiveEntry[] = [];
  const rejected: Rejection[] = [];

  for (const entry of entries) {
    const rejection = evaluate(entry, state, limits);
    // Directory entries are neither accepted nor rejected — they are structural,
    // and every normal archive contains them. Counted as rejections they would
    // make a clean upload look suspicious.
    if (rejection?.reason === "directory-entry") continue;
    if (rejection) rejected.push(rejection);
    else accepted.push(entry);
  }

  return { accepted, rejected, totalBytes: state.totalBytes };
}

export type ExtractionResult = {
  /** Entry path → raw bytes, for accepted non-directory entries only. */
  files: Map<string, Uint8Array>;
  rejected: Rejection[];
  totalBytes: number;
};

/**
 * Extracts an archive in memory. In memory rather than to disk on purpose: the
 * analysis pipeline only ever reads these files as text to embed, so writing
 * them to a shared filesystem would add a temp-directory lifecycle and a
 * cleanup failure mode in exchange for nothing.
 */
export function extractArchive(
  bytes: Uint8Array,
  limits: ExtractionLimits = DEFAULT_LIMITS,
): ExtractionResult {
  const state: RunningState = { acceptedCount: 0, totalBytes: 0 };
  const rejected: Rejection[] = [];
  const files = new Map<string, Uint8Array>();

  const unzipped = unzipSync(bytes, {
    filter: (file) => {
      const rejection = evaluate(
        { path: file.name, size: file.originalSize, compressedSize: file.size },
        state,
        limits,
      );
      if (rejection) {
        if (rejection.reason !== "directory-entry") rejected.push(rejection);
        return false;
      }
      return true;
    },
  });

  for (const [path, content] of Object.entries(unzipped)) {
    files.set(path, content);
  }

  return { files, rejected, totalBytes: state.totalBytes };
}
