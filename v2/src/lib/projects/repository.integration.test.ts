import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { chunks as chunksTable, projects } from "@/db/schema";
import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import { DuplicateProjectError, ingestArchive } from "@/lib/ingestion/service";
import {
  createDrizzleProjectStore,
  deleteProjectForOwner,
  getProjectForOwner,
  listProjectsForOwner,
} from "./repository";
import { searchChunks } from "@/lib/rag/retrieve";

/**
 * Integration coverage for everything the unit suite cannot reach: real
 * pgvector writes, real cosine ordering, real cascade deletes, and real
 * owner-scoped filters.
 *
 * Skipped when DATABASE_URL is absent, so `pnpm test` still runs with no
 * infrastructure. To run it:
 *
 *   docker compose up -d postgres && DATABASE_URL=... pnpm test
 *
 * The vector width matters: the column is vector(768), so these fixtures use a
 * 768-dimension stub. A narrower stub would fail the insert rather than the
 * assertion, which is a confusing way to find out.
 */

const DIMENSIONS = 768;
const databaseConfigured = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const SUITE_DOCUMENTS = {
  "src/OrderLookupService.java":
    "class OrderLookupService { OrderStatusResult lookup(String orderId) { return orderDao.find(orderId); } }",
  "src/PaymentGatewayClient.java":
    "class PaymentGatewayClient { void charge(Order order) { gateway.post(order); } }",
  "database/schema.sql": "create table orders (id uuid primary key, status text not null);",
};

const archive = (): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries(SUITE_DOCUMENTS).map(([path, text]) => [path, strToU8(text)]),
    ),
  );

const embeddings = createStubEmbeddings(DIMENSIONS);

describe.skipIf(!databaseConfigured)("repository + retrieval against live Postgres", () => {
  const ownerId = `itest-${randomUUID()}`;
  const otherOwnerId = `itest-other-${randomUUID()}`;
  let projectId = "";

  beforeAll(async () => {
    const store = createDrizzleProjectStore();
    const result = await ingestArchive({
      ownerId,
      bytes: archive(),
      projectName: "integration-sample.zip",
      store,
      embed: (texts) => embeddings.embed(texts),
    });
    projectId = result.projectId;
  }, 60_000);

  afterAll(async () => {
    // Scoped cleanup: the suite removes only its own rows, whatever the
    // assertions did or did not reach.
    await getDb().delete(projects).where(eq(projects.ownerId, ownerId));
    await getDb().delete(projects).where(eq(projects.ownerId, otherOwnerId));
    await closeDb();
  });

  it("persisted the project with its chunk count", async () => {
    const [project] = await listProjectsForOwner(ownerId);
    expect(project?.id).toBe(projectId);
    expect(project?.fileCount).toBe(3);
    expect(project?.chunkCount).toBeGreaterThan(0);
  });

  it("stored an embedding on every chunk", async () => {
    const rows = await getDb()
      .select({ id: chunksTable.id, embedding: chunksTable.embedding })
      .from(chunksTable)
      .where(eq(chunksTable.projectId, projectId));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.embedding).toHaveLength(DIMENSIONS);
    }
  });

  it("returns real vector results ordered by cosine similarity", async () => {
    // The query is close to one document's text, so that document must come
    // first. This is the assertion that would catch a wrong distance operator or
    // an inverted similarity score — neither of which a stub can detect.
    const [queryVector] = await embeddings.embed([
      "class OrderLookupService { OrderStatusResult lookup(String orderId) }",
    ]);

    const results = await searchChunks({
      projectId,
      queryEmbedding: queryVector ?? [],
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe("src/OrderLookupService.java");

    // A relative separation rather than an absolute floor: the query mirrors one
    // class declaration inside a larger file, so partial token overlap with the
    // rest of that file is expected and an absolute threshold would encode the
    // stub embedder's quirks instead of the retrieval behaviour.
    expect(results[0]?.similarity).toBeGreaterThan(0.8);
    if (results.length > 1) {
      expect(results[0]?.similarity).toBeGreaterThan((results[1]?.similarity ?? 0) + 0.05);
    }

    // Descending order is the other half of "ordered by similarity".
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index]?.similarity).toBeLessThanOrEqual(results[index - 1]?.similarity ?? 0);
    }
  });

  it("honours the similarity floor in SQL", async () => {
    const [queryVector] = await embeddings.embed(["completely unrelated vocabulary zzz"]);
    const results = await searchChunks({
      projectId,
      queryEmbedding: queryVector ?? [],
      limit: 5,
      minSimilarity: 0.99,
    });
    expect(results).toEqual([]);
  });

  it("refuses a byte-identical re-upload against the real database", async () => {
    await expect(
      ingestArchive({
        ownerId,
        bytes: archive(),
        projectName: "integration-sample.zip",
        store: createDrizzleProjectStore(),
        embed: (texts) => embeddings.embed(texts),
      }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);
  });

  it("hides the project from another session entirely", async () => {
    expect(await getProjectForOwner(otherOwnerId, projectId)).toBeNull();
    expect(await listProjectsForOwner(otherOwnerId)).toEqual([]);

    // Chunks are reachable only through a project id, so an unscoped retrieval
    // cannot be composed by guessing an id alone.
    const [queryVector] = await embeddings.embed(["OrderLookupService"]);
    const foreign = await searchChunks({
      projectId: randomUUID(),
      queryEmbedding: queryVector ?? [],
      limit: 5,
    });
    expect(foreign).toEqual([]);
  });

  it("cascades chunk deletion when the owner deletes the project", async () => {
    expect(await deleteProjectForOwner(otherOwnerId, projectId)).toBe(false);

    const temporaryOwner = `itest-delete-${randomUUID()}`;
    const store = createDrizzleProjectStore();
    const created = await ingestArchive({
      ownerId: temporaryOwner,
      bytes: zipSync({ "a.ts": strToU8("export const a = 1;") }),
      projectName: "delete-me.zip",
      store,
      embed: (texts) => embeddings.embed(texts),
    });

    expect(await deleteProjectForOwner(temporaryOwner, created.projectId)).toBe(true);

    const remaining = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(chunksTable)
      .where(and(eq(chunksTable.projectId, created.projectId)));
    expect(remaining[0]?.count).toBe(0);
  });

  it("scopes the duplicate check so the same bytes are fine under a second session", async () => {
    const result = await ingestArchive({
      ownerId: otherOwnerId,
      bytes: archive(),
      projectName: "integration-sample.zip",
      store: createDrizzleProjectStore(),
      embed: (texts) => embeddings.embed(texts),
    });

    expect(result.projectId).not.toBe(projectId);
    expect(await listProjectsForOwner(otherOwnerId)).toHaveLength(1);
  });
});
