import { and, eq, gte, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { chunks as chunksTable } from "@/db/schema";
import type { RankableCandidate } from "./rerank";

/**
 * Vector retrieval, scoped to one project.
 *
 * Similarity is computed in Postgres via pgvector's cosine distance operator
 * (`<=>`); the app never pulls vectors into memory to compare them, which is the
 * difference between a retrieval step that scales with the index and one that
 * scales with the corpus.
 *
 * The `projectId` filter is not optional and not defaulted. Every project's
 * chunks live in the same table — that is what makes multi-project storage work
 * without duplicating infrastructure — so an unscoped query would answer
 * questions about one codebase using another codebase's source.
 */

export type RetrievedChunk = RankableCandidate & {
  fileName: string;
  documentType: string;
  similarity: number;
};

/**
 * pgvector accepts a text literal like `[0.1,0.2,0.3]`. Values are validated
 * here because a NaN or Infinity silently produces a vector that matches nothing
 * or everything, depending on the operator — a failure mode that looks like
 * "retrieval is bad" rather than "the embedding was broken".
 */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error("Cannot build a vector literal from an empty embedding.");
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contained a non-finite value (NaN or Infinity).");
    }
  }
  return `[${embedding.join(",")}]`;
}

export type SearchInput = {
  projectId: string;
  queryEmbedding: number[];
  limit: number;
  /** Cosine similarity floor, 0–1. Applied in SQL so low-quality rows never cross the wire. */
  minSimilarity?: number;
};

export async function searchChunks(
  input: SearchInput,
  db: Database = getDb(),
): Promise<RetrievedChunk[]> {
  const literal = toVectorLiteral(input.queryEmbedding);
  const distance = sql<number>`(${chunksTable.embedding} <=> ${literal}::vector)`;
  const similarity = sql<number>`(1 - ${distance})`;

  const rows = await db
    .select({
      id: chunksTable.id,
      source: chunksTable.source,
      fileName: chunksTable.fileName,
      documentType: chunksTable.documentType,
      content: chunksTable.content,
      similarity,
    })
    .from(chunksTable)
    .where(
      and(
        eq(chunksTable.projectId, input.projectId),
        input.minSimilarity === undefined ? undefined : gte(similarity, input.minSimilarity),
      ),
    )
    .orderBy(distance)
    .limit(input.limit);

  return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
}
