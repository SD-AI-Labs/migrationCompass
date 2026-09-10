"use server";

import { revalidatePath } from "next/cache";

import { getLogger } from "@/lib/observability/logger";
import { deleteProjectForOwner } from "@/lib/projects/repository";
import { getOwnerId } from "@/lib/session";

/**
 * Deletes a project the session owns. Returns quietly when the id belongs to
 * another session or does not exist — from this session's point of view those
 * are the same thing, and saying which would confirm that someone else's project
 * id exists.
 */
export async function deleteProjectAction(formData: FormData): Promise<void> {
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId.length === 0) return;

  const ownerId = await getOwnerId();
  if (!ownerId) return;

  const deleted = await deleteProjectForOwner(ownerId, projectId);
  getLogger().info({ projectId, deleted }, "Project delete requested");
  revalidatePath("/");
}
