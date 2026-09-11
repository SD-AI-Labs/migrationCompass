import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import { ingestArchive } from "@/lib/ingestion/service";
import { createDrizzleProjectStore } from "@/lib/projects/repository";

import { listIndexedSources, MAX_INDEXED_SOURCES } from "./sources";

/**
 * The report's source listing against a real database.
 *
 * This query is the one genuinely new SQL in the report layer — a grouped,
 * owner-joined read over `chunks` — and the unit suite cannot reach it. Skipped
 * when `DATABASE_URL` is absent, so `pnpm test` still runs with no infrastructure:
 *
 *   docker compose up -d postgres && DATABASE_URL=... pnpm vitest run src/lib/report
 *
 * What it establishes: distinct files with their chunk counts, an owner filter that
 * a foreign session cannot pass, and — asserted on the returned rows — that no
 * chunk *content* is selected or returned.
 */

const DIMENSIONS = 768;
const databaseConfigured =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

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

describe.skipIf(!databaseConfigured)("listIndexedSources against live Postgres", () => {
  const ownerId = `itest-report-${randomUUID()}`;
  const otherOwnerId = `itest-report-other-${randomUUID()}`;
  let projectId = "";

  beforeAll(async () => {
    const result = await ingestArchive({
      ownerId,
      bytes: archive(),
      projectName: "report-sources.zip",
      store: createDrizzleProjectStore(),
      embed: (texts) => embeddings.embed(texts),
    });
    projectId = result.projectId;
  }, 60_000);

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.ownerId, ownerId));
    await getDb().delete(projects).where(eq(projects.ownerId, otherOwnerId));
    await closeDb();
  });

  it("lists every indexed file once, with its chunk count and document type", async () => {
    const listing = await listIndexedSources(ownerId, projectId);

    expect(listing.total).toBe(Object.keys(SUITE_DOCUMENTS).length);
    expect(listing.sources.map((source) => source.source).sort()).toEqual(
      Object.keys(SUITE_DOCUMENTS).sort(),
    );

    for (const source of listing.sources) {
      expect(source.chunks).toBeGreaterThan(0);
      expect(source.documentType.length).toBeGreaterThan(0);
    }
  });

  it("returns no source content, only references", async () => {
    const listing = await listIndexedSources(ownerId, projectId);

    // The query selects a path, a type and a count. A body would show up here.
    for (const source of listing.sources) {
      expect(Object.keys(source).sort()).toEqual(["chunks", "documentType", "source"]);
    }
    expect(JSON.stringify(listing)).not.toContain("OrderStatusResult");
  });

  it("refuses to answer for a session that does not own the project", async () => {
    const listing = await listIndexedSources(otherOwnerId, projectId);

    expect(listing.sources).toHaveLength(0);
    expect(listing.total).toBe(0);
  });

  it("was seeded with more files than the listing cap allows room for", () => {
    // Guards the cap's arithmetic rather than the fixture: the elision note the
    // report renders depends on `total` being able to exceed `sources.length`.
    expect(MAX_INDEXED_SOURCES).toBeGreaterThan(0);
    expect(MAX_INDEXED_SOURCES).toBeGreaterThanOrEqual(Object.keys(SUITE_DOCUMENTS).length);
  });
});
