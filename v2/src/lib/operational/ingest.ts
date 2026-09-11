import type { OperationalFile } from "@/lib/scoring/operational";

/**
 * Reading operational data files out of a `FormData` submission.
 *
 * Lives in a normal module rather than inside either Server Action because both the
 * upload path and the refinement path accept operational data, and a second copy of
 * "read the files, skip the empty ones, refuse anything oversized" is exactly the
 * kind of duplication that drifts.
 *
 * Two rules, both about not lying to the user:
 *
 * - an oversized file is **reported**, not silently dropped — a dropped file looks
 *   like an accepted one until someone reads the scorecard;
 * - a file the browser could not read is not represented at all, because there is
 *   nothing truthful to say about its contents.
 */

/** 5 MB: these are log excerpts and metrics exports, not production archives. */
export const OPERATIONAL_FILE_LIMIT_BYTES = 5 * 1024 * 1024;

export type ReadOperationalFiles = {
  files: OperationalFile[];
  /** One actionable sentence per file that was refused. */
  skipped: string[];
};

export async function readOperationalFilesFromFormData(
  formData: FormData,
  field = "operationalFiles",
): Promise<ReadOperationalFiles> {
  const files: OperationalFile[] = [];
  const skipped: string[] = [];

  for (const value of formData.getAll(field)) {
    if (!(value instanceof File) || value.size === 0) continue;

    if (value.size > OPERATIONAL_FILE_LIMIT_BYTES) {
      skipped.push(
        `${value.name} is ${(value.size / 1024 / 1024).toFixed(1)} MB; operational data files are limited to ` +
          `${OPERATIONAL_FILE_LIMIT_BYTES / 1024 / 1024} MB.`,
      );
      continue;
    }

    files.push({ name: value.name, text: await value.text() });
  }

  return { files, skipped };
}
