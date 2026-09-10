import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { analysisRuns, findings, projects, serviceDependencies } from "@/db/schema";
import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import { ingestArchive } from "@/lib/ingestion/service";
import { createDrizzleProjectStore, getProjectForOwner } from "@/lib/projects/repository";

import { AnalysisFailedError, executeAnalysisRun, ProjectNotFoundError, runAnalysis } from "./run";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "./stores";
import {
  architectureJson,
  comparisonJson,
  createFakeModel,
  createFakeTools,
  discoveryJson,
  riskJson,
  type FakeScript,
} from "./testing/fake-model";

/**
 * M3 against a live Postgres.
 *
 * The model and tools are faked — those are not what this covers — while the
 * stores, the schema, the per-run scoping, the cascade behaviour, and the
 * owner isolation are all real. Skipped when DATABASE_URL is absent so the unit
 * suite still runs with no infrastructure:
 *
 *   docker compose up -d postgres && DATABASE_URL=... pnpm test
 */

const databaseConfigured =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const embeddings = createStubEmbeddings(768);

const SAMPLE = zipSync({
  "src/OrderLookupService.java": strToU8(
    "class OrderLookupService { OrderStatusResult lookup(String id) { return dao.find(id); } }",
  ),
  "src/CustomerAccountService.java": strToU8(
    "class CustomerAccountService { void recalculateLoyalty() { /* no tests */ } }",
  ),
  "database/schema.sql": strToU8("create table orders (id uuid primary key, status text not null);"),
});

/**
 * The Discovery fixture, extended so the service a dependency edge points at is
 * also in the inventory — a finding row only exists for services Discovery
 * listed, and the dependent count is what this suite verifies end to end.
 */
const DISCOVERY_FIXTURE = discoveryJson({
  services: [
    {
      name: "OrderLookupService",
      riskLevel: "low",
      riskFactors: ["read-only"],
      recommendation: "Lift and shift first.",
      hasTestCoverageGap: false,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
    },
    {
      name: "CustomerAccountService",
      riskLevel: "high",
      riskFactors: ["handles PII", "no automated tests"],
      recommendation: "Add integration tests before touching it.",
      hasTestCoverageGap: true,
      dataQualityIssueCount: 2,
      requiresMajorRestructuring: true,
    },
    {
      name: "InventoryCheckService",
      riskLevel: "high",
      riskFactors: ["synchronous reservation logic"],
      recommendation: "Split the reservation write path.",
      hasTestCoverageGap: true,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
    },
  ],
});

function script(overrides: FakeScript = {}): FakeScript {
  return {
    "discovery.draft": "discovery narrative",
    "discovery.critique": "Complete",
    "discovery.extract": DISCOVERY_FIXTURE,
    "architecture.draft": "architecture narrative",
    "architecture.critique": "Complete",
    "architecture.extract": architectureJson(),
    "risk.draft": "risk narrative",
    "risk.critique": "Complete",
    "risk.extract": riskJson(),
    "comparison.draft": "comparison narrative",
    "comparison.extract": comparisonJson(),
    ...overrides,
  };
}

describe.skipIf(!databaseConfigured)("analysis runs against live Postgres", () => {
  const ownerId = `m3-owner-${randomUUID()}`;
  const otherOwnerId = `m3-other-${randomUUID()}`;
  let projectId = "";
  let firstRunId = "";

  const deps = () => {
    const model = createFakeModel(script());
    const tools = createFakeTools();
    return {
      model,
      tools,
      runDeps: {
        llm: model.llm,
        tools: tools.tools,
        runStore: createDrizzleRunStore(),
        analysisStore: createDrizzleAnalysisStore(),
        resolveProject: async (requestingOwner: string, requestedProjectId: string) => {
          const project = await getProjectForOwner(requestingOwner, requestedProjectId);
          return project ? { id: project.id, name: project.name } : null;
        },
      },
    };
  };

  beforeAll(async () => {
    const ingested = await ingestArchive({
      ownerId,
      bytes: SAMPLE,
      projectName: "m3-integration.zip",
      store: createDrizzleProjectStore(),
      embed: (texts) => embeddings.embed(texts),
    });
    projectId = ingested.projectId;

    const run = await runAnalysis({ ownerId, projectId, deps: deps().runDeps });
    firstRunId = run.runId;
  }, 120_000);

  afterAll(async () => {
    // Cascades remove the runs, findings, and dependency edges.
    await getDb().delete(projects).where(inArray(projects.ownerId, [ownerId, otherOwnerId]));
    await closeDb();
  });

  it("persists the run as complete with the step done", async () => {
    const [run] = await getDb()
      .select()
      .from(analysisRuns)
      .where(and(eq(analysisRuns.ownerId, ownerId), eq(analysisRuns.id, firstRunId)));

    expect(run?.status).toBe("complete");
    expect(run?.step).toBe("done");
    expect(run?.completedAt).toBeInstanceOf(Date);
    expect(run?.error).toBeNull();
  });

  it("keeps every agent narrative on the run", async () => {
    // The narratives are the run's evidence trail: a score with no report behind
    // it is exactly the opaque number the plan rejects.
    const [run] = await getDb().select().from(analysisRuns).where(eq(analysisRuns.id, firstRunId));

    expect(run?.discoveryReport).toBe("discovery narrative");
    expect(run?.architectureProposal).toBe("architecture narrative");
    expect(run?.riskAssessment).toBe("risk narrative");
    expect(run?.comparisonReport).toBe("comparison narrative");
  });

  it("persists findings with the rubric's structured inputs", async () => {
    const rows = await getDb()
      .select()
      .from(findings)
      .where(and(eq(findings.projectId, projectId), eq(findings.runId, firstRunId)));

    expect(rows.length).toBeGreaterThan(0);

    const customer = rows.find((row) => row.serviceName === "CustomerAccountService");
    expect(customer?.riskLevel).toBe("critical");
    expect(customer?.hasTestCoverageGap).toBe(true);
    expect(customer?.dataQualityIssueCount).toBe(2);
    expect(customer?.requiresMajorRestructuring).toBe(true);
  });

  it("persists dependency edges against both the project and the run", async () => {
    const rows = await getDb()
      .select()
      .from(serviceDependencies)
      .where(and(eq(serviceDependencies.projectId, projectId), eq(serviceDependencies.runId, firstRunId)));

    expect(rows.length).toBeGreaterThan(0);
    const edge = rows.find((row) => row.fromService === "CustomerAccountService");
    expect(edge?.toService).toBe("PostalVerificationApi");
    expect(edge?.type).toBe("sync_call");
  });

  it("stores a dependent count derived from the edges", async () => {
    // The scoring engine reads this number; if the graph were left to reconstruct
    // topology at scoring time, this column would be zero and risk weighting would
    // silently stay equal-weighted.
    const rows = await getDb()
      .select()
      .from(findings)
      .where(and(eq(findings.projectId, projectId), eq(findings.runId, firstRunId)));

    const inventory = rows.find((row) => row.serviceName === "InventoryCheckService");
    expect(inventory?.dependentCount).toBe(1);
  });

  it("adds a second, separate set of results when the project is re-analysed", async () => {
    // The M0 decision: dependencies are per run, so re-analysing produces a second
    // comparable graph rather than overwriting the first.
    const second = await runAnalysis({ ownerId, projectId, deps: deps().runDeps });
    expect(second.runId).not.toBe(firstRunId);

    const first = await getDb().select().from(serviceDependencies).where(eq(serviceDependencies.runId, firstRunId));
    const secondEdges = await getDb()
      .select()
      .from(serviceDependencies)
      .where(eq(serviceDependencies.runId, second.runId));

    expect(first.length).toBeGreaterThan(0);
    expect(secondEdges.length).toBe(first.length);

    // The first run's rows are untouched by the second.
    expect(first.every((row) => row.runId === firstRunId)).toBe(true);
  });

  it("refuses to run an analysis against another session's project", async () => {
    const { runDeps } = deps();

    await expect(
      runAnalysis({ ownerId: otherOwnerId, projectId, deps: runDeps }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const foreignRuns = await getDb()
      .select()
      .from(analysisRuns)
      .where(and(eq(analysisRuns.ownerId, otherOwnerId), eq(analysisRuns.projectId, projectId)));
    expect(foreignRuns).toEqual([]);
  });

  it("keeps the run invisible to another session on read", async () => {
    const store = createDrizzleRunStore();
    expect(await store.getRun(otherOwnerId, firstRunId)).toBeNull();
    expect((await store.getRun(ownerId, firstRunId))?.id).toBe(firstRunId);
  });

  it("persists a failure as failed, with the stage it died in", async () => {
    const model = createFakeModel(script({ "risk.draft": new Error("risk model unavailable") }));
    const tools = createFakeTools();
    const { runId } = await runAnalysis({
      ownerId,
      projectId,
      deps: {
        llm: model.llm,
        tools: tools.tools,
        runStore: createDrizzleRunStore(),
        analysisStore: createDrizzleAnalysisStore(),
        resolveProject: async (requestingOwner, requestedProjectId) => {
          const project = await getProjectForOwner(requestingOwner, requestedProjectId);
          return project ? { id: project.id, name: project.name } : null;
        },
      },
    }).catch((error: unknown) => {
      if (error instanceof AnalysisFailedError) return { runId: error.runId };
      throw error;
    });

    const [run] = await getDb().select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.step).toBe("risk");
    expect(run?.error).toContain("risk model unavailable");
    expect(run?.completedAt).toBeInstanceOf(Date);

    // A failed run writes no partial results for M4 to render.
    const partial = await getDb()
      .select()
      .from(serviceDependencies)
      .where(eq(serviceDependencies.runId, runId));
    expect(partial).toEqual([]);
  });

  it("marks the run failed rather than leaving it running when a stage throws late", async () => {
    const model = createFakeModel(script({ "comparison.draft": new Error("comparison exploded") }));
    const tools = createFakeTools();
    const store = createDrizzleRunStore();

    const { runId } = await runAnalysis({
      ownerId,
      projectId,
      deps: {
        llm: model.llm,
        tools: tools.tools,
        runStore: store,
        analysisStore: createDrizzleAnalysisStore(),
        resolveProject: async (requestingOwner, requestedProjectId) => {
          const project = await getProjectForOwner(requestingOwner, requestedProjectId);
          return project ? { id: project.id, name: project.name } : null;
        },
      },
    }).catch((error: unknown) => {
      if (error instanceof AnalysisFailedError) return { runId: error.runId };
      throw error;
    });

    const record = await store.getRun(ownerId, runId);
    expect(record?.status).toBe("failed");
    expect(record?.status).not.toBe("running");
    expect(record?.step).toBe("comparison");
  });

  it("leaves a created-but-unstarted run visibly pending", async () => {
    // The reason `pending` exists in the schema: a run row that exists but has not
    // started must not claim to be running, so a process that dies between create
    // and start is diagnosable rather than looking like a hung run.
    const store = createDrizzleRunStore();
    const created = await store.create({ projectId, ownerId });

    const record = await store.getRun(ownerId, created.id);
    expect(record?.status).toBe("pending");
    expect(record?.step).toBe("discovery");
    expect(record?.completedAt).toBeNull();

    await executeAnalysisRun({
      runId: created.id,
      projectId,
      deps: {
        llm: createFakeModel(script()).llm,
        tools: createFakeTools().tools,
        runStore: store,
        analysisStore: createDrizzleAnalysisStore(),
      },
    });

    expect((await store.getRun(ownerId, created.id))?.status).toBe("complete");
  });
});
