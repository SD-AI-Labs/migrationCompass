"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { after } from "next/server";

import { hasDatabaseConfig } from "@/db/client";
import { getLogger } from "@/lib/observability/logger";
import { withSpan } from "@/lib/observability/span";
import { ensureOwnerId } from "@/lib/session";

import { createAnalysisRun, executeAnalysisRun, ProjectNotFoundError } from "@/lib/agents/run";
import { createAnalysisDeps } from "@/lib/agents/wiring";

/**
 * Starts an analysis run for a project.
 *
 * Two-phase on purpose. The run row is created and the action returns
 * immediately, then `after()` executes it once the response has been sent. The
 * alternative — awaiting the whole pipeline inside the action — would hold the
 * request open for the several minutes a real analysis takes, and would show the
 * user nothing at all until it finished.
 *
 * What the page gets instead is a run that exists and is `pending`, then
 * `running` as stages advance, then `complete` or `failed`. That is the same
 * pollable-progress contract the plan asks for, and it is why the schema needed a
 * `pending` state: a row that exists but has not started must not claim to be
 * running.
 *
 * Returning early means this action cannot be the thing that reports completion —
 * it is long gone by then. The two halves of that contract live elsewhere and are
 * deliberately paired:
 *
 *  - the runner (`executeAnalysisRun`) writes every state transition and logs it;
 *  - `readAnalysisProgressAction` reads the row back, and the client component in
 *    the project list polls it and re-renders the page when the run finishes.
 *
 * The `revalidatePath` below refreshes the page into its "running" state. It is
 * *not* what shows the results: by the time there are any, the request that
 * triggered it has finished.
 *
 * Failures are already persisted by the runner before it rethrows, so the catch
 * here only stops an unhandled rejection — the run's own record is the source of
 * truth, not this log line.
 */
export async function startAnalysisAction(formData: FormData): Promise<void> {
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId.length === 0) return;

  if (!hasDatabaseConfig()) {
    getLogger().warn("Analysis requested with no database configured");
    return;
  }

  const ownerId = await ensureOwnerId();
  const deps = createAnalysisDeps();

  try {
    const { runId } = await createAnalysisRun({ ownerId, projectId, deps });

    getLogger().info({ projectId, runId, stage: "starting" }, "Analysis run queued");

    after(async () => {
      await withSpan("analysis.run", { "project.id": projectId, "run.id": runId }, async () => {
        try {
          await executeAnalysisRun({ runId, projectId, deps });
        } catch (error) {
          // The run's own record, and the structured line the runner logs, already
          // describe the failure. This exists only so a rejected `after()` promise
          // does not surface as an unhandled rejection.
          getLogger().debug(
            { runId, projectId, error },
            "Analysis run rejected its caller after recording its failure",
          );
        }
      });
    });

    revalidatePath("/");
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      // The project is not visible to this session — deleted, or another session's.
      // Same not-found result as the delete action, so the two cannot be told apart
      // from outside either.
      getLogger().warn({ projectId }, "Analysis requested for an invisible project");
      notFound();
    }
    throw error;
  }
}
