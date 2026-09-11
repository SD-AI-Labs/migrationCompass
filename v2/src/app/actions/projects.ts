"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { getLogger } from "@/lib/observability/logger";
import { deleteProjectForOwner } from "@/lib/projects/repository";
import { getOwnerId } from "@/lib/session";

/**
 * Deletes a project the session owns.
 *
 * A project this session cannot see — because it does not exist, or because it belongs
 * to someone else — produces the not-found result rather than a silent success. The two
 * cases are one outcome from here on purpose: distinguishing them would confirm that
 * another session's project id exists. `notFound()` is the same answer a route handler
 * would give, and the not-found page says exactly that much and no more.
 *
 * The delete itself is owner-scoped in the repository, so the check below cannot be
 * bypassed by racing the lookup.
 */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId.length === 0) return;

  const ownerId = await getOwnerId();
  if (!ownerId) notFound();

  const deleted = await deleteProjectForOwner(ownerId, projectId);
  getLogger().info({ projectId, deleted }, "Project delete requested");

  if (!deleted) {
    // Nothing was removed: either it never existed or it is not this session's. Both
    // are a not-found, and the log line above records which request produced it.
    notFound();
  }

  revalidatePath("/");
}
