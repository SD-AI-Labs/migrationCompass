"use server";

import { createDrizzleRunStore } from "@/lib/agents/stores";
import { absentProgress, toAnalysisProgress, type AnalysisProgress } from "@/lib/agents/progress";
import { hasDatabaseConfig } from "@/db/client";
import { getLogger } from "@/lib/observability/logger";
import { getOwnerId } from "@/lib/session";

/**
 * Reads the state of a project's most recent analysis run.
 *
 * This is the other half of the progress contract the runner writes. The page is a
 * server component: it renders whatever the database held when the request was
 * made, and nothing re-renders it on its own — the only automatic refresh is the
 * one a server action triggers, which happens while the run is still queued. So a
 * browser that started a run and waited had no way to learn it had finished, and
 * the run row sat at `running` on screen until something forced a fresh request.
 * This action is what the client polls to close that gap.
 *
 * A Server Action rather than a route handler, for the same reason upload is: the
 * browser is the only caller, and a second HTTP surface would add a second
 * definition of a payload with exactly one consumer.
 *
 * Deliberately owner-scoped and cheap: one indexed lookup, no findings, no
 * scorecard. The scorecard is loaded by the page's own render after the run
 * completes, so that the numbers are produced once by the path that already owns
 * them.
 */
export async function readAnalysisProgressAction(projectId: string): Promise<AnalysisProgress> {
  if (typeof projectId !== "string" || projectId.length === 0) return absentProgress();
  if (!hasDatabaseConfig()) return absentProgress();

  const ownerId = await getOwnerId();
  if (!ownerId) return absentProgress();

  try {
    const run = await createDrizzleRunStore().latestRun(ownerId, projectId);
    return run ? toAnalysisProgress(run) : absentProgress();
  } catch (error) {
    // Reported as an absent run rather than thrown at the client: the poller keeps
    // the last known state on screen and asks again. A poll that fails is not a
    // run that failed, and telling a reader either of those things would be wrong.
    getLogger().warn(
      {
        projectId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to read analysis progress",
    );
    return absentProgress();
  }
}
