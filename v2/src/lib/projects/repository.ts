import { and, desc, eq } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { chunks as chunksTable, projects } from "@/db/schema";
import type { ProjectStore } from "@/lib/ingestion/service";

/**
 * Drizzle-backed persistence for projects and their chunks.
 *
 * Every read here takes an `ownerId` and filters on it. That is the session
 * isolation the plan requires: project data belongs to the session that uploaded
 * it, and a lookup that forgets the filter leaks another visitor's codebase.
 * Making `ownerId` a required parameter rather than an optional filter puts that
 * in the type signature instead of in a code-review convention.
 */

export type ProjectSummary = {
  id: string;
  name: string;
  sourceType: "example" | "upload";
  fileCount: number;
  chunkCount: number;
  createdAt: Date;
};

/** Insert batch size: pgvector rows are wide, and one statement for a large upload is slow and memory-hungry. */
const CHUNK_INSERT_BATCH = 200;

export function createDrizzleProjectStore(db: Database = getDb()): ProjectStore {
  return {
    async findDuplicate(ownerId, sourceHash) {
      const [existing] = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.ownerId, ownerId), eq(projects.sourceHash, sourceHash)))
        .orderBy(desc(projects.createdAt))
        .limit(1);
      return existing ?? null;
    },

    async createProject(input) {
      const [created] = await db
        .insert(projects)
        .values({
          ownerId: input.ownerId,
          name: input.name,
          sourceType: input.sourceType,
          sourceHash: input.sourceHash,
          fileCount: input.fileCount,
          chunkCount: input.chunkCount,
        })
        .returning({ id: projects.id });
      if (!created) throw new Error("Project insert returned no row.");
      return created;
    },

    async insertChunks(projectId, rows) {
      for (let offset = 0; offset < rows.length; offset += CHUNK_INSERT_BATCH) {
        const batch = rows.slice(offset, offset + CHUNK_INSERT_BATCH);
        await db
          .insert(chunksTable)
          .values(batch.map((chunk) => ({ ...chunk, projectId })));
      }
    },

    async deleteProject(projectId) {
      // Chunks, findings, runs, scorecards, and dependencies cascade from the
      // projects row (see schema.test.ts), so this is a single statement.
      await db.delete(projects).where(eq(projects.id, projectId));
    },
  };
}

export async function listProjectsForOwner(ownerId: string): Promise<ProjectSummary[]> {
  return getDb()
    .select({
      id: projects.id,
      name: projects.name,
      sourceType: projects.sourceType,
      fileCount: projects.fileCount,
      chunkCount: projects.chunkCount,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.ownerId, ownerId))
    .orderBy(desc(projects.createdAt));
}

export async function getProjectForOwner(
  ownerId: string,
  projectId: string,
): Promise<ProjectSummary | null> {
  const [project] = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      sourceType: projects.sourceType,
      fileCount: projects.fileCount,
      chunkCount: projects.chunkCount,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.id, projectId)))
    .limit(1);
  return project ?? null;
}

/** Returns false when the project does not exist or belongs to another session. */
export async function deleteProjectForOwner(ownerId: string, projectId: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(projects)
    .where(and(eq(projects.ownerId, ownerId), eq(projects.id, projectId)))
    .returning({ id: projects.id });
  return deleted.length > 0;
}
