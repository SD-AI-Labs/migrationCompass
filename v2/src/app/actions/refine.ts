"use server";

import { revalidatePath } from "next/cache";

import { hasDatabaseConfig } from "@/db/client";
import { readOperationalFilesFromFormData } from "@/lib/operational/ingest";
import {
  clearOperationalDataForOwner,
  loadRefinementInputsForOwner,
  saveRefinementForOwner,
} from "@/lib/operational/repository";
import { getLogger } from "@/lib/observability/logger";
import { withSpan } from "@/lib/observability/span";
import { loadScorecardForProject } from "@/lib/scoring/loader";
import { parseOperationalFiles } from "@/lib/scoring/operational";
import { hasAnyParameter, validateParameters } from "@/lib/scoring/parameters";
import { ensureOwnerId } from "@/lib/session";

import { initialRefineState, type RefineState, type RemoveOperationalState } from "./refine-state";

/**
 * "Refine these estimates" — the deterministic recalculation path.
 *
 * Deliberately *not* the "Run analysis" action. This one writes the two cheap inputs
 * (operational data files, migration parameters) and re-renders the scorecard, which
 * recomputes the five numbers with `recomputeScorecard()`. No model is called, no
 * retrieval happens, and the narrative findings are untouched — the UI says so
 * explicitly, because the difference between "the estimate improved" and "the
 * analysis changed" matters to whoever is reading it.
 *
 * Failures are reported per file. A submission with two good files and one broken one
 * stores the two and names the third, rather than discarding the batch.
 *
 * This module only exports async functions: it is a `"use server"` file, and the
 * state types live in `refine-state.ts` for that reason.
 */

export async function refineEstimatesAction(
  _previous: RefineState,
  formData: FormData,
): Promise<RefineState> {
  const projectId = readProjectId(formData);
  if (projectId === null) {
    return { ...initialRefineState, status: "error", message: "No project was identified for this refinement." };
  }

  if (!hasDatabaseConfig()) {
    return {
      status: "error",
      message: "No database is configured, so a refinement cannot be stored.",
      detail: "Set DATABASE_URL and run `pnpm db:migrate`.",
    };
  }

  const fileRead = await readOperationalFilesFromFormData(formData);
  const parsed = parseOperationalFiles(fileRead.files);
  const rejected = [...fileRead.skipped, ...parsed.errors.map((error) => error.error)];

  const validation = validateParameters({
    targetEnvironment: formData.get("targetEnvironment"),
    provider: formData.get("provider"),
    teamSize: formData.get("teamSize"),
    weeklyRate: formData.get("weeklyRate"),
    budget: formData.get("budget"),
    timelineWeeks: formData.get("timelineWeeks"),
  });

  if (!validation.ok) {
    return {
      status: "error",
      message: "Some migration parameters were not usable, so nothing was changed.",
      errors: Object.values(validation.errors),
      detail: "Correct the values above and submit again — the stored estimates are unchanged.",
    };
  }

  const hasParameters = hasAnyParameter(validation.values);

  if (parsed.entries.length === 0 && !hasParameters) {
    return {
      status: "error",
      message:
        rejected.length > 0
          ? "No operational data file could be read, and no migration parameters were supplied."
          : "Nothing to refine with yet — attach an operational data file or set a migration parameter.",
      errors: rejected,
      detail:
        "Accepted operational data: .log (logs), .json (health/traffic/db stats), .md or .txt (incident reports).",
    };
  }

  const ownerId = await ensureOwnerId();

  return withSpan("refine.estimates", { "project.id": projectId }, async () => {
    try {
      const saved = await saveRefinementForOwner(ownerId, projectId, {
        entries: parsed.entries,
        parameters: validation.values,
        // Submitted deliberately, so it replaces what was stored — including clearing a
        // field the user removed. A merge would make "unset this budget" impossible.
        writeParameters: true,
      });

      if (saved === null) {
        // Owner-scoped miss: another session's project is indistinguishable from one
        // that does not exist, and that is the point.
        return {
          status: "error",
          message: "That project is not visible to this session, so nothing was changed.",
        };
      }

      revalidatePath("/");

      const loaded = await loadScorecardForProject(ownerId, projectId);
      const stored = await loadRefinementInputsForOwner(ownerId, projectId);
      const storedFiles = stored?.entries.length ?? parsed.entries.length;

      if (rejected.length > 0) {
        return {
          status: "partial",
          message:
            `Recalculated with ${parsed.entries.length} of ${parsed.entries.length + rejected.length} ` +
            `operational data file(s) — ${rejected.length} could not be read.`,
          errors: rejected,
          detail: loaded?.refinement.description,
          storedFiles,
        };
      }

      return {
        status: "success",
        message:
          parsed.entries.length > 0
            ? `Recalculated with ${parsed.entries.length} operational data file(s)`
            : "Recalculated with the submitted migration parameters",
        detail: loaded?.refinement.description,
        storedFiles,
      };
    } catch (error) {
      getLogger().error({ error, projectId }, "Refinement failed");
      return {
        status: "error",
        message: "The refinement could not be stored, so the estimates are unchanged.",
        // The message is passed through because this path is the ingest of user files;
        // the log line above carries the diagnostic detail.
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Removes every operational data file for this project. Migration parameters stay. */
export async function removeOperationalDataAction(
  _previous: RemoveOperationalState,
  formData: FormData,
): Promise<RemoveOperationalState> {
  const projectId = readProjectId(formData);
  if (projectId === null) {
    return { status: "error", message: "No project was identified for this request." };
  }

  if (!hasDatabaseConfig()) {
    return { status: "error", message: "No database is configured." };
  }

  try {
    const ownerId = await ensureOwnerId();
    const removed = await clearOperationalDataForOwner(ownerId, projectId);

    if (removed === null) {
      return { status: "error", message: "That project is not visible to this session." };
    }

    revalidatePath("/");

    return {
      status: "success",
      message:
        removed === 0
          ? "There was no operational data to remove; the estimates were already code-only."
          : `Removed ${removed} operational data file(s). The estimates are code-only again.`,
    };
  } catch (error) {
    getLogger().error({ error, projectId }, "Removing operational data failed");
    // Deliberately generic: the database's own message is a diagnostic, not something
    // to put in front of a user.
    return { status: "error", message: "The operational data could not be removed." };
  }
}

function readProjectId(formData: FormData): string | null {
  const value = formData.get("projectId");
  return typeof value === "string" && value.length > 0 ? value : null;
}
