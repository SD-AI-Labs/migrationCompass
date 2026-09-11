import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { strToU8, zipSync } from "fflate";

/**
 * Packs a directory into a byte-reproducible zip.
 *
 * Reproducibility is the whole point, not a nicety: duplicate detection hashes the
 * archive bytes, so an archive built with "now" as every entry's modification time
 * — and with directory iteration order, which is filesystem-dependent — hashes
 * differently on every run. The same fixture then looks like a brand-new upload
 * every time and creates a duplicate project. Sorting the entries and pinning the
 * timestamp makes the bytes a function of the content alone.
 *
 * Shared by the seed script and the fixture-backed tests so that both go through
 * the same packing, and a test cannot pass on an archive the seed would not build.
 */

/** Fixed modification time applied to every entry. 2026-01-01T00:00:00Z. */
export const FIXED_ARCHIVE_MTIME = new Date("2026-01-01T00:00:00Z");

/** Directories never worth walking into when packing a fixture. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".next"]);

export async function collectDirectoryFiles(
  root: string,
  dir: string = root,
  acc: Record<string, Uint8Array> = {},
): Promise<Record<string, Uint8Array>> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await collectDirectoryFiles(root, absolute, acc);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = relative(root, absolute).split(sep).join("/");
    acc[relativePath] = strToU8(await readFile(absolute, "utf8"));
  }

  return acc;
}

/** Sorted so the archive's entry order does not depend on the filesystem. */
export function buildArchive(files: Record<string, Uint8Array>): Uint8Array {
  const sorted: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files).sort()) {
    sorted[path] = files[path] as Uint8Array;
  }
  return zipSync(sorted, { mtime: FIXED_ARCHIVE_MTIME });
}

/** Convenience: walk a directory and pack it in one step. */
export async function archiveDirectory(root: string): Promise<Uint8Array> {
  return buildArchive(await collectDirectoryFiles(root));
}
