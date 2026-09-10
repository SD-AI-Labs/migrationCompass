"use server";

import { revalidatePath } from "next/cache";
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

    after(async () => {
      await withSpan("analysis.run", { "project.id": projectId, "run.id": runId }, async () => {
        try {
          const result = await executeAnalysisRun({ runId, projectId, deps });
          getLogger().info(
            {
              runId,
              findings: result.persisted.findings.length,
              dependencies: result.persisted.dependencies.length,
              undiscoveredServices: result.persisted.undiscoveredServices,
            },
            "Analysis run completed",
          );
        } catch (error) {
          // Already persisted as failed by the runner; logged here so the process
          // log and the run record agree.
          getLogger().error({ runId, error }, "Analysis run failed");
        }
      });
    });

    revalidatePath("/");
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      getLogger().warn({ projectId }, "Analysis requested for an invisible project");
      return;
    }
    throw error;
  }
}
