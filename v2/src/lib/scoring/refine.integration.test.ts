import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { analysisRuns, findings, migrationParameters, operationalData, projects } from "@/db/schema";
import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import { ingestArchive } from "@/lib/ingestion/service";
import {
  clearOperationalDataForOwner,
  createDrizzleOperationalStore,
  loadRefinementInputsForOwner,
  saveRefinementForOwner,
} from "@/lib/operational/repository";
import { createDrizzleProjectStore, getProjectForOwner } from "@/lib/projects/repository";
import { loadScorecardForProject } from "@/lib/scoring/loader";
import { EMPTY_PARAMETERS } from "@/lib/scoring/parameters";
import {
  loadSampleFixtureExpectation,
  sampleFixtureArchive,
  sampleFixtureFindings,
} from "@/lib/testing/sample-fixture";

import { runAnalysis } from "@/lib/agents/run";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "@/lib/agents/stores";
import {
  architectureJson,
  comparisonJson,
  createFakeModel,
  createFakeTools,
  riskJson,
} from "@/lib/agents/testing/fake-model";

/**
 * M5 against a live Postgres.
 *
 * The point of this suite is the *persistence boundary* the pure tests cannot reach:
 * operational data and migration parameters are written through the owner-scoped
 * store, read back by the scorecard loader, and the refinement that results must
 * leave everything else in the database exactly as it was — the run's narratives and
 * the run's findings included. That last property is the plan's hard requirement
 * ("cheap feedback loop stays instant, costly work stays an explicit action"), and it
 * is only provable by reading the rows back.
 *
 *   sample fixture → ingestion → M3 run (faked model) → scorecard (code-only)
 *                  → operational data + parameters → scorecard (refined)
 *
 * Skipped when DATABASE_URL is absent:
 *
 *   docker compose up -d postgres && DATABASE_URL=... pnpm test:integration
 */

const databaseConfigured =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const embeddings = createStubEmbeddings(768);

function discoveryFromFixture(): string {
  const expectation = loadSampleFixtureExpectation();

  return JSON.stringify({
    systemName: "sample-legacy-api",
    summary: "Three legacy WebLogic services sharing one Oracle schema.",
    services: expectation.services.map((service) => ({
      name: service.name,
      riskLevel: service.riskLevel,
      riskFactors: service.evidence,
      recommendation: `Address ${service.evidence.length} recorded signal(s) before migration.`,
      hasTestCoverageGap: service.hasTestCoverageGap,
      dataQualityIssueCount: service.dataQualityIssueCount,
      requiresMajorRestructuring: service.requiresMajorRestructuring,
    })),
    dependencies: expectation.dependencies.map((dependency) => ({
      from: dependency.from,
      to: dependency.to,
      type: dependency.type === "sync_call" ? "synchronous call" : "external api",
      evidence: dependency.evidence,
    })),
    techStack: ["Java EE", "WebLogic", "Oracle"],
    databaseOverview: "Single Oracle schema shared by all three services.",
    messagingOverview: "None — every integration is a synchronous HTTP call.",
    externalIntegrations: "Payment processor only.",
    runtimeIssues: "Duplicate charges after browser retries; stale cached customer names.",
  });
}

function script() {
  const expectation = loadSampleFixtureExpectation();

  return {
    "discovery.draft": "discovery narrative",
    "discovery.critique": "Complete",
    "discovery.extract": discoveryFromFixture(),
    "architecture.draft": "architecture narrative",
    "architecture.critique": "Complete",
    "architecture.extract": architectureJson({
      currentArchitectureLargelySound: false,
      phasedPlan: [
        { phaseNumber: 1, title: "Extract customer-service", servicesInvolved: ["customer-service"], rationale: "Read path." },
        { phaseNumber: 2, title: "Extract order-service", servicesInvolved: ["order-service"], rationale: "Write path." },
        { phaseNumber: 3, title: "Rebuild payment-service", servicesInvolved: ["payment-service"], rationale: "Needs restructuring." },
      ],
    }),
    "risk.draft": "risk narrative",
    "risk.critique": "Complete",
    "risk.extract": riskJson({
      ranked: expectation.services.map((service) => ({
        serviceName: service.name,
        riskLevel: service.riskLevel,
        reasoning: service.evidence[0],
        evidenceSource: "static_analysis",
      })),
      operationalDataAvailable: false,
    }),
    "comparison.draft": "comparison narrative",
    "comparison.extract": comparisonJson(),
  };
}

describe.skipIf(!databaseConfigured)("M5 refinement against a live database", () => {
  const ownerId = `m5-owner-${randomUUID()}`;
  const otherOwnerId = `m5-other-${randomUUID()}`;
  let projectId = "";
  let runId = "";
  let narrativesBefore: Record<string, string | null> = {};

  beforeAll(async () => {
    const ingested = await ingestArchive({
      ownerId,
      bytes: await sampleFixtureArchive(),
      projectName: "sample-legacy-api.zip",
      store: createDrizzleProjectStore(),
      embed: (texts) => embeddings.embed(texts),
    });
    projectId = ingested.projectId;

    const model = createFakeModel(script());
    const tools = createFakeTools();
    const run = await runAnalysis({
      ownerId,
      projectId,
      deps: {
        llm: model.llm,
        tools: tools.tools,
        runStore: createDrizzleRunStore(),
        analysisStore: createDrizzleAnalysisStore(),
        resolveProject: async (requestingOwner: string, requestedProjectId: string) => {
          const project = await getProjectForOwner(requestingOwner, requestedProjectId);
          return project ? { id: project.id, name: project.name } : null;
        },
      },
    });
    runId = run.runId;

    const [row] = await getDb().select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    narrativesBefore = {
      discoveryReport: row?.discoveryReport ?? null,
      architectureProposal: row?.architectureProposal ?? null,
      riskAssessment: row?.riskAssessment ?? null,
      comparisonReport: row?.comparisonReport ?? null,
    };
  }, 180_000);

  afterAll(async () => {
    await getDb().delete(projects).where(inArray(projects.ownerId, [ownerId, otherOwnerId]));
    await closeDb();
  });

  it("starts from the code-only baseline, with no operational data stored", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    expect(loaded.scorecard.confidence.codeOnly).toBe(true);
    expect(loaded.scorecard.confidence.label).toBe("code-only estimate");
    expect(loaded.refinement.changed).toBe(false);
    expect(loaded.refinement.operational.available).toBe(false);
    expect(loaded.scorecard.risk).toBeCloseTo(loaded.baseline.risk, 5);
    // The refined path is the only path, so the baseline is produced by the same
    // recalculation with no inputs rather than by a second implementation.
    expect(loaded.scorecard.riskDelta).toBe(0);
  });

  it("stores operational data, and the next load is refined by it", async () => {
    const saved = await saveRefinementForOwner(ownerId, projectId, {
      entries: [
        {
          kind: "health",
          source: "health.json",
          serviceName: "payment-service",
          content: null,
          payload: { errorRatePercent: 12, uptimePercent: 97.4 },
        },
        {
          kind: "incident",
          source: "incidents.json",
          serviceName: "payment-service",
          content: null,
          payload: { incidents: [{ severity: "critical" }, { severity: "critical" }] },
        },
      ],
    });

    expect(saved?.addedEntries).toBe(2);

    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    expect(loaded.refinement.changed).toBe(true);
    expect(loaded.refinement.operational.entries).toBe(2);
    expect(loaded.scorecard.risk).toBeGreaterThan(loaded.baseline.risk);
    expect(loaded.scorecard.riskDelta).toBeGreaterThan(0);
    expect(loaded.scorecard.confidence.codeOnly).toBe(false);
    expect(loaded.scorecard.confidence.label).toBe("refined with operational data");
    expect(loaded.explanation.operational).not.toBeNull();
  });

  it("leaves the analysis run's narratives and findings untouched", async () => {
    // The core M5 guarantee: a refinement changes the scorecard calculation and
    // nothing else. Read back the rows rather than trusting the loader's types.
    const [row] = await getDb().select().from(analysisRuns).where(eq(analysisRuns.id, runId));

    expect({
      discoveryReport: row?.discoveryReport ?? null,
      architectureProposal: row?.architectureProposal ?? null,
      riskAssessment: row?.riskAssessment ?? null,
      comparisonReport: row?.comparisonReport ?? null,
    }).toEqual(narrativesBefore);

    const findingRows = await getDb().select().from(findings).where(eq(findings.runId, runId));
    expect(findingRows).toHaveLength(3);
    expect(
      findingRows
        .map((finding) => ({
          serviceName: finding.serviceName,
          riskLevel: finding.riskLevel,
          hasTestCoverageGap: finding.hasTestCoverageGap,
          dataQualityIssueCount: finding.dataQualityIssueCount,
          requiresMajorRestructuring: finding.requiresMajorRestructuring,
          dependentCount: finding.dependentCount,
        }))
        .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    ).toEqual(
      sampleFixtureFindings()
        .map((finding) => ({
          serviceName: finding.serviceName,
          riskLevel: finding.riskLevel,
          hasTestCoverageGap: finding.hasTestCoverageGap,
          dataQualityIssueCount: finding.dataQualityIssueCount,
          requiresMajorRestructuring: finding.requiresMajorRestructuring,
          dependentCount: finding.dependentCount,
        }))
        .sort((a, b) => a.serviceName.localeCompare(b.serviceName)),
    );
    // The refined numbers are not persisted onto the run row either — they are
    // recomputed from these rows and the stored inputs.
    expect(row?.architectureOutput).toBeTruthy();
  });

  it("accumulates operational data across submissions instead of replacing it", async () => {
    await saveRefinementForOwner(ownerId, projectId, {
      entries: [
        { kind: "log", source: "app.log", serviceName: null, content: "INFO ok\nERROR boom", payload: null },
      ],
    });

    const inputs = await loadRefinementInputsForOwner(ownerId, projectId);
    expect(inputs?.entries).toHaveLength(3);

    const rows = await getDb().select().from(operationalData).where(eq(operationalData.projectId, projectId));
    expect(rows).toHaveLength(3);
  });

  it("round-trips migration parameters, replacing rather than duplicating", async () => {
    await saveRefinementForOwner(ownerId, projectId, {
      parameters: {
        ...EMPTY_PARAMETERS,
        targetEnvironment: "cloud",
        provider: "AWS eu-west-1",
        teamSize: 9,
        weeklyRate: 7200,
        budget: 900_000,
        timelineWeeks: 30,
      },
    });

    const first = await loadScorecardForProject(ownerId, projectId);
    expect(first?.refinement.parametersInForce.teamSize).toBe(9);
    expect(first?.refinement.parametersInForce.weeklyRate).toBe(7200);
    // The parameters move cost through the rubric, not beside it.
    expect(first?.scorecard.assumptions.teamSize).toBe(9);

    await saveRefinementForOwner(ownerId, projectId, {
      parameters: { ...EMPTY_PARAMETERS, teamSize: 3 },
    });

    const second = await loadScorecardForProject(ownerId, projectId);
    expect(second?.refinement.parametersInForce.teamSize).toBe(3);
    // Cleared fields are cleared: a replace, not a merge. Otherwise "unset the budget"
    // would be impossible to express.
    expect(second?.refinement.parametersInForce.budget).toBeNull();
    expect(second?.refinement.parametersInForce.targetEnvironment).toBeNull();

    const parameterRows = await getDb()
      .select()
      .from(migrationParameters)
      .where(eq(migrationParameters.projectId, projectId));
    expect(parameterRows).toHaveLength(1);
  });

  it("refuses to refine a project belonging to another session", async () => {
    expect(
      await saveRefinementForOwner(otherOwnerId, projectId, {
        entries: [{ kind: "log", source: "x.log", serviceName: null, content: "ERROR x", payload: null }],
      }),
    ).toBeNull();
    expect(await loadRefinementInputsForOwner(otherOwnerId, projectId)).toBeNull();
    expect(await clearOperationalDataForOwner(otherOwnerId, projectId)).toBeNull();

    // Nothing was written by the refused attempts: still exactly three entries.
    const rows = await getDb().select().from(operationalData).where(eq(operationalData.projectId, projectId));
    expect(rows).toHaveLength(3);
  });

  it("removes operational data and returns the scores to the code-only baseline", async () => {
    const removed = await clearOperationalDataForOwner(ownerId, projectId);
    expect(removed).toBe(3);

    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    expect(loaded.refinement.operational.available).toBe(false);
    expect(loaded.scorecard.confidence.codeOnly).toBe(true);
    expect(loaded.scorecard.risk).toBeCloseTo(loaded.baseline.risk, 5);
    // The migration parameters survive a removal of the operational data: they are a
    // different kind of input, removed by a different action.
    expect(loaded.refinement.parametersInForce.teamSize).toBe(3);
  });

  it("reads stored operational data through the store in the same shape the parser produces", async () => {
    const store = createDrizzleOperationalStore();
    const entries = await store.listEntries(projectId);

    expect(entries).toEqual([]);
    expect(await store.readParameters(projectId)).toEqual({ ...EMPTY_PARAMETERS, teamSize: 3 });
  });

  it("is deterministic: the same stored inputs produce the same refined scorecard", async () => {
    const first = await loadScorecardForProject(ownerId, projectId);
    const second = await loadScorecardForProject(ownerId, projectId);

    expect(second?.scorecard).toEqual(first?.scorecard);
    expect(second?.refinement.description).toBe(first?.refinement.description);
  });
});
