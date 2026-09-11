import { describe, expect, it } from "vitest";

import {
  architectureOutputSchema,
  comparisonOutputSchema,
  discoveryOutputSchema,
  riskAssessmentSchema,
} from "@/lib/agents/schemas";
import { buildDependencyGraph } from "@/lib/graph/build-graph";
import type { ProjectSummary } from "@/lib/projects/repository";
import { OPERATIONAL_RISK } from "@/lib/scoring/assumptions";
import { parseOperationalFiles } from "@/lib/scoring/operational";
import type { MigrationParametersInput } from "@/lib/scoring/parameters";
import { describeRefinement, recomputeScorecard } from "@/lib/scoring/refine";
import type { ScorecardInput, ScoringDependency, ScoringFinding } from "@/lib/scoring/rubric";
import type { LoadedScorecard } from "@/lib/scoring/loader";
import { sampleOperationalFiles } from "@/lib/testing/sample-fixture";

import { buildAnalysisReport, longestChain, type ReportInput } from "./builder";
import { REPORT_SECTION_IDS } from "./types";

/**
 * The Analysis Report's content contract.
 *
 * Two things are being established here, and they are the two that matter:
 *
 *  1. **Every statement comes from the data.** The fixtures are parsed through the
 *     same schema the pipeline validates with and scored by the real rubric, so the
 *     report is composed from genuine structured analysis rather than from
 *     hand-written expectations about what a report should say.
 *  2. **The report cannot disagree with the scorecard.** The estimate section's
 *     numbers are asserted to be literally the scorecard's formatted values, and the
 *     architecture section is asserted against the graph model the view renders.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FINDINGS: ScoringFinding[] = [
  {
    serviceName: "OrderService",
    riskLevel: "critical",
    hasTestCoverageGap: true,
    dataQualityIssueCount: 3,
    requiresMajorRestructuring: true,
    dependentCount: 2,
  },
  {
    serviceName: "PaymentService",
    riskLevel: "high",
    hasTestCoverageGap: true,
    dataQualityIssueCount: 1,
    requiresMajorRestructuring: false,
    dependentCount: 1,
  },
  {
    serviceName: "InventoryService",
    riskLevel: "medium",
    hasTestCoverageGap: false,
    dataQualityIssueCount: 0,
    requiresMajorRestructuring: false,
    dependentCount: 1,
  },
  {
    serviceName: "BillingService",
    riskLevel: "low",
    hasTestCoverageGap: false,
    dataQualityIssueCount: 0,
    requiresMajorRestructuring: false,
    dependentCount: 0,
  },
  {
    serviceName: "ReportingService",
    riskLevel: "low",
    hasTestCoverageGap: false,
    dataQualityIssueCount: 0,
    requiresMajorRestructuring: false,
    dependentCount: 0,
  },
];

const DEPENDENCIES: ScoringDependency[] = [
  { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
  { fromService: "OrderService", toService: "PaymentService", type: "async_event" },
  { fromService: "PaymentService", toService: "BillingService", type: "sync_call" },
  { fromService: "BillingService", toService: "OrderService", type: "shared_db" },
  { fromService: "PaymentService", toService: "InventoryService", type: "shared_db" },
  { fromService: "InventoryService", toService: "LegacyExt", type: "unknown" },
];

const DISCOVERY = discoveryOutputSchema.parse({
  systemName: "Legacy Order Platform",
  summary: "Five services share one Oracle schema; ordering is the load-bearing component.",
  services: [
    {
      name: "OrderService",
      riskLevel: "critical",
      riskFactors: ["shared mutable schema", "no regression suite"],
      recommendation: "Split the schema before extracting the service.",
      hasTestCoverageGap: true,
      dataQualityIssueCount: 3,
      requiresMajorRestructuring: true,
    },
    {
      name: "PaymentService",
      riskLevel: "high",
      riskFactors: ["synchronous settlement call"],
      hasTestCoverageGap: true,
      dataQualityIssueCount: 1,
      requiresMajorRestructuring: false,
    },
    {
      name: "InventoryService",
      riskLevel: "medium",
      riskFactors: [],
      hasTestCoverageGap: false,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
    },
  ],
  dependencies: [
    {
      from: "OrderService",
      to: "InventoryService",
      type: "synchronous call",
      evidence: "InventoryRepository injected into OrderService constructor",
    },
    {
      from: "PaymentService",
      to: "BillingService",
      type: "synchronous call",
      evidence: "BillingClient.charge() invoked from PaymentService.capture()",
    },
  ],
  techStack: ["Java 8", "Spring 4", "Oracle 11g", "JMS"],
  databaseOverview: "One Oracle schema shared by every service.",
  messagingOverview: "Two JMS queues carry order events.",
  externalIntegrations: "A third-party payment gateway is called synchronously.",
  runtimeIssues: "Heap pressure reported during nightly batch runs.",
});

const ARCHITECTURE = architectureOutputSchema.parse({
  migrationApproach: "Strangler fig starting with the read path, one bounded context at a time.",
  proposedServices: ["order-api", "inventory-api"],
  keyTechnologyChoices: ["PostgreSQL per service", "Kafka for order events"],
  currentArchitectureLargelySound: true,
  phasedPlan: [
    {
      phaseNumber: 2,
      title: "Extract inventory reads",
      servicesInvolved: ["InventoryService"],
      rationale: "Reads are stateless and can be shadowed.",
    },
    {
      phaseNumber: 1,
      title: "Introduce an order API facade",
      servicesInvolved: ["OrderService"],
      rationale: "Gives one seam to cut behind.",
    },
  ],
});

const RISK = riskAssessmentSchema.parse({
  ranked: [
    {
      serviceName: "orderservice",
      riskLevel: "critical",
      reasoning: "Schema coupling means the data model changes with every release.",
      evidenceSource: "logs",
    },
    {
      serviceName: "PaymentService",
      riskLevel: "high",
      reasoning: "Settlement is synchronous and has no fallback.",
      evidenceSource: "operational_data",
    },
    {
      serviceName: "InventoryService",
      riskLevel: "medium",
      reasoning: "Read-only paths, but called on the critical path.",
      evidenceSource: "static_analysis",
    },
    {
      serviceName: "BillingService",
      riskLevel: "low",
      reasoning: "Small and already isolated.",
      evidenceSource: "static_analysis",
    },
    {
      serviceName: "ReportingService",
      riskLevel: "low",
      reasoning: "Batch only, no live traffic.",
      evidenceSource: "none",
    },
  ],
  operationalDataAvailable: true,
});

const COMPARISON = comparisonOutputSchema.parse({
  matched: ["OrderService is the load-bearing service"],
  missed: ["The payment gateway timeout path"],
  incorrect: ["InventoryService was described as stateful"],
  accuracyAssessment: "Broadly accurate on the inventory, thin on integration failure modes.",
});

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "legacy-order-platform.zip",
  sourceType: "upload",
  fileCount: 24,
  chunkCount: 131,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

const PARAMETERS: MigrationParametersInput = {
  targetEnvironment: "cloud",
  provider: "rds",
  teamSize: 8,
  weeklyRate: 1500,
  budget: 400_000,
  timelineWeeks: 20,
};

type FixtureOptions = {
  findings?: ScoringFinding[];
  dependencies?: ScoringDependency[];
  outputs?: boolean;
  comparison?: boolean;
  operational?: boolean;
  parameters?: boolean;
};

function loadedScorecard(options: FixtureOptions = {}): LoadedScorecard {
  const input: ScorecardInput = {
    findings: options.findings ?? FINDINGS,
    dependencies: options.dependencies ?? DEPENDENCIES,
  };

  const operational = options.operational === false
    ? []
    : parseOperationalFiles(sampleOperationalFiles("healthy")).entries;

  const refined = recomputeScorecard({
    input,
    entries: operational,
    parameters: options.parameters === false ? undefined : PARAMETERS,
  });

  const includeOutputs = options.outputs !== false;

  return {
    run: {
      id: "run-1",
      projectId: PROJECT.id,
      ownerId: "owner-1",
      status: "complete",
      step: "done",
      error: null,
      createdAt: new Date("2026-01-02T03:10:00.000Z"),
      completedAt: new Date("2026-01-02T03:12:00.000Z"),
      outputs: { discovery: null, architecture: null, risk: null, comparison: null },
    },
    input: refined.input,
    scorecard: refined.scorecard,
    explanation: refined.explanation,
    baseline: refined.baseline,
    outputs: includeOutputs
      ? {
          discovery: DISCOVERY,
          architecture: ARCHITECTURE,
          risk: RISK,
          comparison: options.comparison === false ? undefined : COMPARISON,
        }
      : {},
    refinement: {
      operational: refined.operational,
      adjustment: refined.adjustment,
      parameters: refined.parameters,
      parametersInForce: refined.parametersInForce,
      changed: refined.changed,
      description: describeRefinement(refined),
    },
  };
}

const SOURCES = {
  sources: [
    { source: "src/main/java/com/legacy/OrderService.java", documentType: "source", chunks: 12 },
    { source: "docs/schema.sql", documentType: "spec", chunks: 4 },
    { source: "ops/app.log", documentType: "log", chunks: 2 },
  ],
  total: 24,
};

function reportInput(options: FixtureOptions = {}): ReportInput {
  const loaded = loadedScorecard(options);
  return {
    project: PROJECT,
    loaded,
    graph: buildDependencyGraph({
      services: loaded.input.findings,
      dependencies: loaded.input.dependencies,
    }),
    sources: SOURCES,
  };
}

const sectionById = (input: ReportInput, id: string) => {
  const section = buildAnalysisReport(input).sections.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`no section ${id}`);
  return section;
};

// ─── Structure ──────────────────────────────────────────────────────────────

describe("report structure", () => {
  it("builds every section, in reading order, from the structured analysis", () => {
    const report = buildAnalysisReport(reportInput());

    expect(report.sections.map((section) => section.id)).toEqual([...REPORT_SECTION_IDS]);
    expect(report.empty).toBe(false);
    expect(report.runId).toBe("run-1");
    expect(report.projectId).toBe(PROJECT.id);

    // Every section explains itself in the collapsed state and can be asked about.
    for (const section of report.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.summary.length).toBeGreaterThan(0);
      expect(section.emptyNote.length).toBeGreaterThan(0);
      expect(section.ask.question.length).toBeGreaterThan(0);
      expect(section.ask.context).toContain("Report ·");
    }
  });

  it("is deterministic for the same analysis", () => {
    expect(buildAnalysisReport(reportInput())).toEqual(buildAnalysisReport(reportInput()));
  });

  it("never calls a model: the module has no LLM or fetch import", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./builder.ts", import.meta.url), "utf8"),
    );

    expect(source).not.toMatch(/@\/lib\/llm|@\/lib\/rag|\bfetch\(/);
  });
});

// ─── Executive summary ──────────────────────────────────────────────────────

describe("executive summary", () => {
  it("states what was discovered, the posture, the top concern and the direction", () => {
    const report = buildAnalysisReport(reportInput());
    const summary = report.summaryParagraphs.join("\n");

    expect(summary).toContain(DISCOVERY.summary);
    expect(summary).toMatch(/migration readiness/i);
    expect(summary).toContain("OrderService at critical risk");
    expect(summary).toContain("OrderService — the schema coupling".slice(0, 12));
    // The recorded approach is the Architecture stage's own words.
    expect(summary).toContain(ARCHITECTURE.migrationApproach);
    expect(summary).toContain("phase 1 is “Introduce an order API facade”");
    expect(summary).toContain("circular dependency chain");
  });

  it("prints the rubric's own numbers rather than describing them", () => {
    const input = reportInput();
    const summary = buildAnalysisReport(input).summaryParagraphs.join("\n");

    expect(summary).toContain(`${input.loaded.scorecard.readiness.toFixed(1)} / 100`);
    expect(summary).toContain(`${input.loaded.scorecard.risk.toFixed(1)} / 100`);
    expect(summary).toContain(input.loaded.scorecard.confidence.label);
  });

  it("says so when nothing is critical or high", () => {
    const findings = FINDINGS.map((finding) => ({ ...finding, riskLevel: "low" as const }));
    const report = buildAnalysisReport(reportInput({ findings }));

    expect(report.summaryParagraphs.join("\n")).toContain("No service was rated critical or high");
  });

  it("highlights the key findings, most severe first, with severity in words", () => {
    const report = buildAnalysisReport(reportInput());

    expect(report.highlights.length).toBeGreaterThan(0);
    expect(report.highlights[0]?.label).toContain("OrderService");
    expect(report.highlights[0]?.tone).toBe("critical");
    // The Risk stage's reasoning, not a rephrasing of the label.
    expect(report.highlights[0]?.detail).toBe(RISK.ranked[0]?.reasoning);

    const labels = report.highlights.map((item) => item.label).join(" | ");
    expect(labels).toContain("require major restructuring");
    expect(labels).toContain("test-coverage gap");
    expect(labels).toContain("Circular dependency");
  });

  it("carries an ask context describing the executive summary", () => {
    const section = sectionById(reportInput(), "executive-summary");

    expect(section.ask.question).toContain(PROJECT.name);
    expect(section.ask.context).toContain("readiness");
  });

  it("reports the five scorecard metrics as counts", () => {
    const section = sectionById(reportInput(), "executive-summary");

    expect(section.counts.map((count) => count.label)).toEqual([
      "Migration Readiness",
      "Risk",
      "Effort",
      "Cost",
      "Time",
    ]);
  });
});

// ─── System discovery ───────────────────────────────────────────────────────

describe("system discovery", () => {
  it("describes each discovered service with its structured traits", () => {
    const section = sectionById(reportInput(), "discovery");
    const order = section.items.find((item) => item.label === "OrderService");

    expect(order?.detail).toContain("critical risk");
    expect(order?.detail).toContain("test-coverage gap");
    expect(order?.detail).toContain("needs major restructuring");
    expect(order?.detail).toContain("3 data-quality issue(s)");
    expect(order?.tone).toBe("critical");
    // Risk factors are cited as evidence, from the Discovery output.
    expect(order?.evidence).toContain("shared mutable schema");
  });

  it("carries the technology, storage, messaging and integration overviews", () => {
    const section = sectionById(reportInput(), "discovery");
    const labels = section.items.map((item) => item.label);

    expect(labels).toContain("Database and storage");
    expect(labels).toContain("Messaging");
    expect(labels).toContain("External integrations");
    expect(labels).toContain("Runtime issues");
    expect(labels.some((label) => label.startsWith("Technology stack"))).toBe(true);

    expect(section.counts).toEqual(
      expect.arrayContaining([
        { label: "Services", value: "5" },
        { label: "Dependency edges", value: "6" },
        { label: "Indexed files", value: "24" },
        { label: "Chunks", value: "131" },
      ]),
    );
  });

  it("says what is missing when Discovery produced nothing", () => {
    const section = sectionById(reportInput({ outputs: false }), "discovery");

    expect(section.summary).toContain("No Discovery output was persisted");
    expect(section.items).toHaveLength(5);
    expect(section.emptyNote).toContain("nothing to describe");
  });
});

// ─── Architecture analysis ──────────────────────────────────────────────────

describe("architecture analysis", () => {
  it("reads coupling off the same graph model the view renders", () => {
    const input = reportInput();
    const section = sectionById(input, "architecture");
    const mostDependedUpon = [...input.graph.nodes].sort((a, b) => b.incoming - a.incoming)[0];

    const fanIn = section.items.find((item) => item.id === `architecture-fanin-${mostDependedUpon?.id}`);
    expect(fanIn?.label).toContain(`${mostDependedUpon?.incoming} dependent`);
    expect(section.counts).toEqual(
      expect.arrayContaining([
        { label: "Graph nodes", value: String(input.graph.nodes.length) },
        { label: "Graph edges", value: String(input.graph.edges.length) },
      ]),
    );
    expect(section.summary).toContain("circular chain");
  });

  it("names the circular chain and the longest chain", () => {
    const section = sectionById(reportInput(), "architecture");

    expect(section.items.some((item) => item.id.startsWith("architecture-cycle-"))).toBe(true);
    const chain = section.items.find((item) => item.id === "architecture-critical-path");
    expect(chain?.detail).toContain("→");
  });

  it("calls out shared-database coupling and unclassified edges", () => {
    const section = sectionById(reportInput(), "architecture");
    const ids = section.items.map((item) => item.id);

    expect(ids).toContain("architecture-shared-db");
    expect(ids).toContain("architecture-unclassified");
  });

  it("reports services with no recorded relationships without claiming why", () => {
    const section = sectionById(reportInput(), "architecture");
    const isolated = section.items.find((item) => item.id === "architecture-isolated");

    expect(isolated?.label).toContain("no recorded relationships");
    expect(isolated?.detail).toContain("cannot distinguish");
  });

  it("reports the architecture stage's own soundness statement", () => {
    const section = sectionById(reportInput(), "architecture");
    const soundness = section.items.find((item) => item.id === "architecture-soundness");

    expect(soundness?.label).toContain("largely sound");
    expect(soundness?.tone).toBe("positive");
    expect(soundness?.evidence.join(" ")).toContain("order-api");
  });

  it("says so when no edges were recorded", () => {
    const section = sectionById(reportInput({ dependencies: [] }), "architecture");

    expect(section.summary).toContain("No dependency edges were recorded");
    expect(section.counts).toEqual(
      expect.arrayContaining([{ label: "Graph nodes", value: "5" }]),
    );
  });

  it("derives the longest chain from the graph's layering, cycle-safely", () => {
    const input = reportInput();
    const chain = longestChain(input.graph, (id) => id);

    expect(chain.length).toBeGreaterThan(1);
    // Every step is a real edge in the model.
    for (let index = 0; index < chain.length - 1; index += 1) {
      const from = chain[index];
      const to = chain[index + 1];
      expect(input.graph.edges.some((edge) => edge.source === from && edge.target === to)).toBe(true);
    }
    // No node appears twice, even though the fixture graph contains a cycle.
    expect(new Set(chain).size).toBe(chain.length);
  });
});

// ─── Risk analysis ──────────────────────────────────────────────────────────

describe("risk analysis", () => {
  it("orders findings by severity, then by dependents", () => {
    const section = sectionById(reportInput(), "risk");

    expect(section.items.map((item) => item.label)).toEqual([
      "OrderService — critical",
      "PaymentService — high",
      "InventoryService — medium",
      "BillingService — low",
      "ReportingService — low",
    ]);
  });

  it("explains each rating with the stage's reasoning and the evidence behind it", () => {
    const section = sectionById(reportInput(), "risk");
    const order = section.items[0];

    expect(order?.detail).toBe(RISK.ranked[0]?.reasoning);
    expect(order?.evidence).toEqual(
      expect.arrayContaining([
        "rubric level value 100/100",
        "2 dependent services",
        "recorded test-coverage gap",
        "recorded as needing major restructuring",
        "rating evidence: operational logs supplied with the project",
        "shared mutable schema",
      ]),
    );
  });

  it("states the level values the rubric uses and the weighting in force", () => {
    const input = reportInput();
    const section = sectionById(input, "risk");

    expect(section.summary).toContain("100/75/50/25");
    expect(section.summary).toContain(`${input.loaded.scorecard.riskWeighting === "dependency" ? "dependency-weighted" : "equal-weighted"} mean`);
  });

  it("counts findings per severity", () => {
    const section = sectionById(reportInput(), "risk");

    expect(section.counts).toEqual([
      { label: "critical", value: "1" },
      { label: "high", value: "1" },
      { label: "medium", value: "1" },
      { label: "low", value: "2" },
      { label: "Findings", value: "5" },
    ]);
  });

  it("asks about its most severe finding", () => {
    const section = sectionById(reportInput(), "risk");

    expect(section.ask.question).toContain("OrderService");
    expect(section.ask.context).toContain("1 critical finding");
    expect(section.items[0]?.ask?.question).toContain("OrderService");
  });

  it("states plainly when no findings were persisted", () => {
    const section = sectionById(reportInput({ findings: [] }), "risk");

    expect(section.summary).toContain("No findings were persisted");
    expect(section.items).toHaveLength(0);
    expect(section.emptyNote).toContain("nothing to rate");
  });
});

// ─── Findings by service ────────────────────────────────────────────────────

describe("findings by service", () => {
  it("groups the findings by affected service, most severe first", () => {
    const section = sectionById(reportInput(), "service-findings");

    expect(section.items.map((item) => item.label)).toEqual([
      "OrderService",
      "PaymentService",
      "InventoryService",
      "BillingService",
      "ReportingService",
      "LegacyExt",
    ]);
    expect(section.items[0]?.tone).toBe("critical");
  });

  it("carries the service's severity, rubric inputs and dependent count", () => {
    const section = sectionById(reportInput(), "service-findings");
    const order = section.items.find((item) => item.label === "OrderService");

    expect(order?.detail).toBe(
      "critical risk · needs major restructuring · test-coverage gap · 3 data-quality issue(s) · 2 dependents",
    );
  });

  it("keeps the recommendation, the rating evidence and the service's dependencies together", () => {
    const section = sectionById(reportInput(), "service-findings");
    const order = section.items.find((item) => item.label === "OrderService");
    const evidence = order?.evidence.join("\n") ?? "";

    // The Discovery stage's recommendation for this service.
    expect(evidence).toContain("Recommendation: Split the schema before extracting the service.");
    // The rubric's own contribution to the rating.
    expect(evidence).toContain("rubric level value 100/100");
    // Risk factors, from the Discovery output's service entry.
    expect(evidence).toContain("shared mutable schema");
    // Both directions of the topology, from the graph model.
    expect(evidence).toMatch(/Calls: .*InventoryService \(synchronous call\)/);
    expect(evidence).toMatch(/Called by: .*BillingService \(shared database\)/);
  });

  it("says when a service has no recorded relationships instead of leaving it ambiguous", () => {
    const section = sectionById(reportInput(), "service-findings");
    const reporting = section.items.find((item) => item.label === "ReportingService");

    expect(reporting?.evidence).toContain(
      "No recorded relationships — the analysis found no edge for it.",
    );
  });

  it("lists services that appear only in the edges as unrated, which is a fact not an omission", () => {
    const section = sectionById(reportInput(), "service-findings");
    const unrated = section.items.find((item) => item.label === "LegacyExt");

    expect(unrated?.detail).toContain("unrated");
    expect(unrated?.tone).toBe("neutral");
    expect(unrated?.evidence).toEqual(["1 dependent, 0 dependencies recorded"]);
    expect(section.counts).toEqual(
      expect.arrayContaining([{ label: "Unrated (edges only)", value: "1" }]),
    );
  });

  it("counts the services, severities, restructuring and coverage gaps", () => {
    const section = sectionById(reportInput(), "service-findings");

    expect(section.counts).toEqual([
      { label: "Services with findings", value: "5" },
      { label: "Critical or high", value: "2" },
      { label: "Needs restructuring", value: "1" },
      { label: "Coverage gaps", value: "2" },
      { label: "Unrated (edges only)", value: "1" },
    ]);
  });

  it("offers a per-service question and a section-level one", () => {
    const section = sectionById(reportInput(), "service-findings");
    const order = section.items.find((item) => item.label === "OrderService");

    expect(order?.ask?.question).toBe("What needs to happen to OrderService, and what depends on it?");
    expect(order?.ask?.context).toContain("Service finding: OrderService");
    expect(section.ask.question).toContain(PROJECT.name);
  });

  it("caps a large inventory and still states the real count", () => {
    const findings = Array.from({ length: 45 }, (_, index) => ({
      serviceName: `Service${String(index).padStart(2, "0")}`,
      riskLevel: "low" as const,
      hasTestCoverageGap: false,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
      dependentCount: 0,
    }));

    const section = sectionById(reportInput({ findings, dependencies: [] }), "service-findings");

    expect(section.items).toHaveLength(40);
    expect(section.counts).toEqual(
      expect.arrayContaining([{ label: "Services with findings", value: "45" }]),
    );
    expect(section.summary).toContain("45 services");
  });

  it("says what is missing when no service findings were persisted", () => {
    const section = sectionById(reportInput({ findings: [], dependencies: [] }), "service-findings");

    expect(section.items).toHaveLength(0);
    expect(section.summary).toContain("No service findings were persisted");
    expect(section.emptyNote).toContain("nothing to group by service");
  });
});

// ─── Migration considerations ───────────────────────────────────────────────

describe("migration considerations", () => {
  it("separates straightforward areas from the ones needing restructuring", () => {
    const section = sectionById(reportInput(), "migration");
    const straightforward = section.items.find((item) => item.id === "migration-straightforward");
    const restructuring = section.items.find((item) => item.id === "migration-restructuring");

    expect(straightforward?.detail).toContain("InventoryService");
    expect(straightforward?.detail).toContain("BillingService");
    expect(straightforward?.detail).not.toContain("OrderService");
    expect(restructuring?.detail).toContain("OrderService (2 dependent");
    expect(restructuring?.tone).toBe("high");
  });

  it("lists the recorded coverage gaps", () => {
    const section = sectionById(reportInput(), "migration");
    const coverage = section.items.find((item) => item.id === "migration-coverage");

    expect(coverage?.detail).toContain("OrderService");
    expect(coverage?.detail).toContain("PaymentService");
    expect(section.counts).toEqual(
      expect.arrayContaining([{ label: "Coverage gaps", value: "2" }]),
    );
  });

  it("orders the phased plan by phase number", () => {
    const section = sectionById(reportInput(), "migration");
    const phases = section.items.filter((item) => item.id.startsWith("migration-phase-"));

    expect(phases.map((phase) => phase.label)).toEqual([
      "Phase 1 · Introduce an order API facade",
      "Phase 2 · Extract inventory reads",
    ]);
    expect(phases[0]?.detail).toContain("one seam to cut behind");
  });

  it("records what has to move together", () => {
    const section = sectionById(reportInput(), "migration");
    const sequencing = section.items.filter((item) => item.id.startsWith("migration-sequencing-"));

    expect(sequencing.length).toBeGreaterThan(0);
    expect(sequencing.every((item) => item.detail.includes("depend on it directly"))).toBe(true);
  });
});

// ─── Estimates ──────────────────────────────────────────────────────────────

describe("effort and cost explanation", () => {
  it("states exactly the scorecard's numbers", () => {
    const input = reportInput();
    const section = sectionById(input, "estimates");
    const { explanation } = input.loaded;

    // The same formatter the scorecard uses, so these strings are the scorecard's.
    expect(section.items.find((item) => item.id === "estimates-effort")?.label).toBe(
      `Effort — ${explanation.scores.effort.value.toFixed(1)} / 10`,
    );
    expect(section.items.find((item) => item.id === "estimates-cost")?.label).toBe(
      `Cost — ${explanation.scores.cost.unit} ${Math.round(explanation.scores.cost.value).toLocaleString("en-US")}`,
    );
    expect(section.items.find((item) => item.id === "estimates-time")?.label).toContain(
      `${explanation.scores.time.value} weeks`,
    );
    expect(section.counts).toEqual(
      expect.arrayContaining([
        { label: "Effort", value: `${explanation.scores.effort.value.toFixed(1)} / 10` },
        { label: "Confidence", value: input.loaded.scorecard.confidence.label },
        { label: "Evidence quality", value: explanation.evidence.level },
      ]),
    );
  });

  it("names the rubric's own contributors for each estimate", () => {
    const section = sectionById(reportInput(), "estimates");
    const effort = section.items.find((item) => item.id === "estimates-effort");
    const cost = section.items.find((item) => item.id === "estimates-cost");

    expect(effort?.evidence.join(" ")).toContain("Risk");
    expect(effort?.evidence.join(" ")).toMatch(/weight 0\.3/);
    expect(cost?.evidence.join(" ")).toContain("Person-weeks");
  });

  it("shows the assumptions in force, from the scorecard's own assumptions", () => {
    const section = sectionById(reportInput(), "estimates");
    const assumptions = section.items.find((item) => item.id === "estimates-assumptions");

    expect(assumptions?.label).toContain("8 × USD 1,500");
    expect(assumptions?.evidence.join(" ")).toContain("Team size");
  });

  it("explains the operational adjustment when refinement data exists", () => {
    const input = reportInput();
    const section = sectionById(input, "estimates");
    const operational = section.items.find((item) => item.id === "estimates-operational");

    expect(input.loaded.refinement.changed).toBe(true);
    expect(operational?.label).toContain("Operational data moved Risk");
    expect(operational?.label).toContain(`${input.loaded.refinement.adjustment.delta}`);
    expect(operational?.evidence.join(" ")).toContain(
      `bounded to ±${OPERATIONAL_RISK.maxAdjustment} points`,
    );
  });

  it("says the estimate is code-only when no operational data was applied", () => {
    const section = sectionById(reportInput({ operational: false }), "estimates");
    const operational = section.items.find((item) => item.id === "estimates-operational");

    expect(operational?.label).toBe("No operational data applied");
    expect(operational?.detail).toContain("code-only estimates");
  });

  it("reports the migration parameters that were recorded", () => {
    const section = sectionById(reportInput(), "estimates");
    const parameters = section.items.find((item) => item.id === "estimates-parameters");

    expect(parameters?.evidence.join(" ")).toContain("Team size");
    expect(parameters?.detail).toContain("never lowers a cost estimate");
  });

  it("omits the parameters item when none were recorded", () => {
    const section = sectionById(reportInput({ parameters: false }), "estimates");

    expect(section.items.some((item) => item.id === "estimates-parameters")).toBe(false);
  });
});

// ─── Evidence ───────────────────────────────────────────────────────────────

describe("evidence", () => {
  it("lists the indexed files, their type and their chunk counts", () => {
    const section = sectionById(reportInput(), "evidence");

    expect(section.items.find((item) => item.label === "src/main/java/com/legacy/OrderService.java")?.detail).toBe(
      "source · 12 chunks indexed",
    );
    expect(section.counts).toEqual(
      expect.arrayContaining([
        { label: "Source files listed", value: "3 of 24" },
        { label: "Chunks", value: "131" },
      ]),
    );
    // The elision is stated, not silent.
    expect(section.summary).toContain("3 of 24");
  });

  it("separates indexed sources, cited findings and edges with evidence", () => {
    const section = sectionById(reportInput(), "evidence");
    const ids = section.items.map((item) => item.id);

    expect(ids).toContain("evidence-quality");
    expect(ids).toContain("evidence-finding-orderservice");
    expect(ids.some((id) => id.startsWith("evidence-edge-"))).toBe(true);
    expect(section.items.find((item) => item.id === "evidence-quality")?.evidence.length).toBeGreaterThan(0);
  });

  it("carries the static-analysis evidence behind a dependency edge", () => {
    const section = sectionById(reportInput(), "evidence");
    const edge = section.items.find((item) => item.id.startsWith("evidence-edge-"));

    expect(edge?.detail).toContain("synchronous call");
    expect(edge?.detail).toContain("Repository injected");
  });

  it("reports the comparison stage's self-assessment, including what it missed", () => {
    const section = sectionById(reportInput(), "evidence");
    const comparison = section.items.find((item) => item.id === "evidence-comparison");

    expect(comparison?.detail).toBe(COMPARISON.accuracyAssessment);
    expect(comparison?.evidence).toEqual(
      expect.arrayContaining([
        "matched: 1",
        "missed: 1",
        "incorrect: 1",
        "missed: The payment gateway timeout path",
      ]),
    );
  });

  it("never carries raw source content, even when it is handed in", () => {
    const input = reportInput();
    // A caller passing more than the listing needs must not leak it: the report
    // renders the fields it knows, not whatever object it was given.
    const withContent = {
      ...input,
      sources: {
        sources: [
          {
            source: "src/Secret.java",
            documentType: "source",
            chunks: 1,
            content: "SENTINEL-RAW-SOURCE-CONTENT",
          },
        ],
        total: 1,
      },
    } as unknown as ReportInput;

    expect(JSON.stringify(buildAnalysisReport(withContent))).not.toContain("SENTINEL-RAW-SOURCE-CONTENT");
  });

  it("says what is missing when nothing was indexed", () => {
    const section = sectionById(
      { ...reportInput(), sources: { sources: [], total: 0 } },
      "evidence",
    );

    expect(section.summary).toContain("0 indexed source files");
  });
});

// ─── Empty report ───────────────────────────────────────────────────────────

describe("empty report state", () => {
  it("flags a run with no structured output and no findings, and explains why", () => {
    const report = buildAnalysisReport(
      reportInput({ outputs: false, findings: [], dependencies: [] }),
    );

    expect(report.empty).toBe(true);
    expect(report.emptyReason).toContain("no structured analysis output and no findings");
    // The sections still exist, each with its honest note, so the shape is stable.
    expect(report.sections.map((section) => section.id)).toEqual([...REPORT_SECTION_IDS]);
    for (const id of ["discovery", "architecture", "risk", "migration"]) {
      expect(report.sections.find((section) => section.id === id)?.items).toHaveLength(0);
    }
    expect(report.highlights).toHaveLength(0);
  });

  it("is not empty when only the outputs are missing but findings exist", () => {
    const report = buildAnalysisReport(reportInput({ outputs: false }));

    expect(report.empty).toBe(false);
    expect(report.summaryParagraphs.join(" ")).toContain("No Discovery output was persisted");
  });
});
