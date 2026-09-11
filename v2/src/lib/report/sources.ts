import { and, asc, count, eq, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { chunks as chunksTable, projects as projectsTable } from "@/db/schema";
import { getLogger } from "@/lib/observability/logger";

import type { IndexedSourceListing } from "./types";

/**
 * Which files were indexed for a project — the report's evidence list.
 *
 * A read of existing data, not new persistence: the `chunks` table already records
 * one row per extracted chunk with its source path and document type, so the
 * inventory the report needs has been there since ingestion.
 *
 * Three deliberate properties:
 *
 * 1. **No content is selected.** The query returns a path, a document type and a
 *    chunk count. The report cites files; it never quotes them.
 * 2. **It is owner-scoped through a join, not by trusting the caller's projectId.**
 *    Every read path in this codebase filters on the session, and this one keeps
 *    that shape even though the caller already resolved the project.
 * 3. **It fails soft.** A source list that cannot be read must not take the page
 *    with it — the report says what it has and the caller logs the reason.
 */
export const MAX_INDEXED_SOURCES = 60;

export async function listIndexedSources(
  ownerId: string,
  projectId: string,
  db: Database = getDb(),
): Promise<IndexedSourceListing> {
  try {
    const rows = await db
      .select({
        source: chunksTable.source,
        documentType: chunksTable.documentType,
        chunks: count(),
      })
      .from(chunksTable)
      .innerJoin(projectsTable, eq(projectsTable.id, chunksTable.projectId))
      .where(and(eq(projectsTable.ownerId, ownerId), eq(chunksTable.projectId, projectId)))
      .groupBy(chunksTable.source, chunksTable.documentType)
      .orderBy(asc(chunksTable.source))
      .limit(MAX_INDEXED_SOURCES);

    const [totalRow] = await db
      .select({ total: sql<number>`count(distinct ${chunksTable.source})::int` })
      .from(chunksTable)
      .innerJoin(projectsTable, eq(projectsTable.id, chunksTable.projectId))
      .where(and(eq(projectsTable.ownerId, ownerId), eq(chunksTable.projectId, projectId)));

    return {
      sources: rows.map((row) => ({
        source: row.source,
        documentType: row.documentType,
        chunks: Number(row.chunks),
      })),
      total: Number(totalRow?.total ?? rows.length),
    };
  } catch (error) {
    getLogger().error(
      {
        projectId,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
      "Failed to list indexed sources for the analysis report",
    );
    return { sources: [], total: 0 };
  }
}
