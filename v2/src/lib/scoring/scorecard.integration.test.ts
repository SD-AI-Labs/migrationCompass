import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { analysisRuns, projects, scorecards } from "@/db/schema";
import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import { buildDependencyGraph } from "@/lib/graph/build-graph";
import { ingestArchive } from "@/lib/ingestion/service";
import { createDrizzleProjectStore, getProjectForOwner } from "@/lib/projects/repository";
import {
  loadSampleFixtureExpectation,
  sampleFixtureArchive,
  sampleFixtureFindings,
} from "@/lib/testing/sample-fixture";

import { runAnalysis } from "@/lib/agents/run";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "@/lib/agents/stores";
import { architectureJson, comparisonJson, createFakeModel, createFakeTools, riskJson } from "@/lib/agents/testing/fake-model";
import { explainScorecard, verifyContributions } from "./explain";
import { loadScorecardForProject } from "./loader";
import { computeRiskScore } from "./weights";

/**
 * M4 against a live Postgres, from the checked-in fixture.
 *
 *   sample fixture  →  ingestion  →  M3 analysis (faked model)  →  persisted
 *   findings + edges + structured outputs  →  M4 scorecard
 *
 * The model is faked because the point here is the *data path*, not generation:
 * what this proves is that the scorecard reads the structured rows M3 wrote and
 * arrives at the same numbers the pure rubric produces from the fixture's own
 * expectation. Embeddings are stubbed; Ollama is not required.
 *
 * Skipped when DATABASE_URL is absent, like the M3 integration suite:
 *
 *   docker compose up -d postgres && DATABASE_URL=... pnpm test
 */

const databaseConfigured =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

const embeddings = createStubEmbeddings(768);

/** The fixture's designed structure, expressed the way Discovery reports it. */
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
    // Human-readable type names on purpose: this exercises the M3 normalization
    // that turns them into the persisted `sync_call` / `external_api` values the
    // scoring path and the graph consume.
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

describe.skipIf(!databaseConfigured)("M4 scorecard from the sample fixture", () => {
  const ownerId = `m4-owner-${randomUUID()}`;
  const otherOwnerId = `m4-other-${randomUUID()}`;
  let projectId = "";
  let runId = "";

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
  }, 180_000);

  afterAll(async () => {
    // Cascades remove the runs, findings, and dependency edges.
    await getDb().delete(projects).where(inArray(projects.ownerId, [ownerId, otherOwnerId]));
    await closeDb();
  });

  it("ingested the fixture's real source files", async () => {
    const project = await getProjectForOwner(ownerId, projectId);
    const expectation = loadSampleFixtureExpectation();

    expect(project).not.toBeNull();
    expect(project?.fileCount).toBeGreaterThan(expectation.services.length);
    expect(project?.chunkCount).toBeGreaterThan(0);
  });

  it("persisted the run's structured outputs, not only the narratives", async () => {
    const [row] = await getDb().select().from(analysisRuns).where(eq(analysisRuns.id, runId));

    expect(row?.status).toBe("complete");
    expect(row?.discoveryOutput).toBeTruthy();
    expect(row?.architectureOutput).toBeTruthy();
    expect(row?.riskOutput).toBeTruthy();
    expect(row?.comparisonOutput).toBeTruthy();
    // The persisted architecture output is what supplies the phase count the effort
    // rubric needs; if it were missing, effort would silently lose a term.
    expect(
      (row?.architectureOutput as { phasedPlan?: unknown[] } | null)?.phasedPlan,
    ).toHaveLength(3);
  });

  it("loads a scorecard for the run's most recent completed run", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);

    expect(loaded).not.toBeNull();
    expect(loaded?.run.id).toBe(runId);
    expect(loaded?.scorecard.counts).toEqual({ services: 3, dependencies: 3, phases: 3 });
  });

  it("computes the same risk the pure rubric computes from the fixture's expectation", () => {
    // The strongest statement available here: the DB-backed path and the in-memory
    // path agree, so nothing in persistence or loading is reshaping the inputs.
    return loadScorecardForProject(ownerId, projectId).then((loaded) => {
      expect(loaded?.scorecard.risk).toBeCloseTo(computeRiskScore(sampleFixtureFindings(), "equal"), 1);
      expect(loaded?.scorecard.risk).toBeGreaterThan(66);
    });
  });

  it("derives dependent counts from the persisted edges", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    const dependents = new Map(
      loaded?.input.findings.map((finding) => [finding.serviceName, finding.dependentCount]),
    );

    // customer-service → order-service → payment-service, so the chain's tail is
    // depended on and its head is not.
    expect(dependents.get("customer-service")).toBe(0);
    expect(dependents.get("order-service")).toBe(1);
    expect(dependents.get("payment-service")).toBe(1);
  });

  it("uses the persisted dependency type names, not the model's prose", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);

    expect(loaded?.input.dependencies.map((dependency) => dependency.type).sort()).toEqual([
      "external_api",
      "sync_call",
      "sync_call",
    ]);
  });

  it("exposes confidence metadata derived from the evidence, with a code-only tag", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    // The scripted comparison reports one thing the analysis missed, so the evidence
    // is partial rather than strong — and the reason says which signal downgraded it,
    // because a confidence tag nobody can trace is just a different opaque number.
    expect(loaded.scorecard.confidence.evidence.level).toBe("partial");
    expect(loaded.scorecard.confidence.evidence.reasons.join(" ")).toMatch(
      /comparison stage flagged 1 item/,
    );
    expect(loaded.scorecard.confidence.label).toBe("code-only estimate");
    // Three services, three edges and an architecture output are all present, so the
    // only downgrade is the comparison miss — not a missing input.
    expect(loaded.scorecard.confidence.evidence.reasons).toHaveLength(1);
  });

  it("explains every score from contributions that sum", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    for (const name of ["risk", "effort", "readiness"] as const) {
      expect(verifyContributions(loaded.explanation.scores[name])).toBe(true);
    }
    // Cost and time are products, so they are shown as factors rather than a sum.
    expect(loaded.explanation.scores.cost.additive).toBe(false);
    expect(loaded.explanation.scores.time.additive).toBe(false);
    expect(loaded.explanation.scores.cost.factors.length).toBeGreaterThan(0);
  });

  it("agrees with an independently built explanation of the same input", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    const recomputed = explainScorecard(loaded.input);
    expect(recomputed.scores.readiness.value).toBe(loaded.explanation.scores.readiness.value);
    expect(recomputed.scores.effort.value).toBe(loaded.explanation.scores.effort.value);
  });

  it("builds the dependency graph from persisted edges, with no rediscovery", async () => {
    const loaded = await loadScorecardForProject(ownerId, projectId);
    if (!loaded) throw new Error("expected a scorecard");

    const graph = buildDependencyGraph({
      services: loaded.input.findings,
      dependencies: loaded.input.dependencies,
    });

    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
    expect(graph.cycles).toEqual([]);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      "customer-service->order-service:sync_call",
      "order-service->payment-service:sync_call",
      "payment-service->external-payment-gateway:external_api",
    ]);
    // Risk on the node comes from the persisted finding, not from the graph's own guess.
    expect(graph.nodes.find((node) => node.id === "payment-service")?.riskLevel).toBe("critical");
    expect(graph.nodes.find((node) => node.id === "external-payment-gateway")?.riskLevel).toBe("unknown");
  });

  it("is deterministic: two independent loads produce identical results", async () => {
    const first = await loadScorecardForProject(ownerId, projectId);
    const second = await loadScorecardForProject(ownerId, projectId);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("refuses to score a project for an owner who does not own it", async () => {
    expect(await loadScorecardForProject(otherOwnerId, projectId)).toBeNull();
    expect(await getDb().select().from(projects).where(eq(projects.ownerId, otherOwnerId))).toEqual([]);
  });

  it("leaves the scorecards table untouched, because M4 computes on read", async () => {
    // A deliberate decision rather than an oversight: recomputation from persisted
    // findings is instant and cannot go stale, so persisting a scorecard would add a
    // cache-invalidation problem for no benefit. M5 will write this table when
    // user-adjusted assumptions need to be remembered.
    const rows = await getDb().select().from(scorecards).where(eq(scorecards.runId, runId));

    expect(rows).toEqual([]);
  });
});
