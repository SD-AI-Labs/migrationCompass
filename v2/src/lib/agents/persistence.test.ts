import { describe, expect, it } from "vitest";

import type { DiscoveryOutput, RiskOutput } from "./schemas";
import {
  buildPersistencePlan,
  computeDependentCounts,
  mergeFindings,
  persistAnalysis,
  type AnalysisStore,
  type NewDependency,
  type NewFinding,
  type StoredDependency,
  type StoredFinding,
} from "./persistence";
import { discoveryJson, riskJson } from "./testing/fake-model";
import { discoveryOutputSchema, riskAssessmentSchema, parseAgentOutput } from "./schemas";

const discovery = (overrides: Record<string, unknown> = {}): DiscoveryOutput =>
  parseAgentOutput(discoveryJson(overrides), discoveryOutputSchema, "discovery");

const risk = (overrides: Record<string, unknown> = {}): RiskOutput =>
  parseAgentOutput(riskJson(overrides), riskAssessmentSchema, "risk");

describe("computeDependentCounts", () => {
  it("counts distinct dependents, not edges", () => {
    // A service called from three call sites by one neighbour has ONE dependent.
    // Counting edges would make a chatty neighbour look like a load-bearing hub,
    // and this number is meant to weight risk by blast radius.
    const counts = computeDependentCounts([
      { from: "A", to: "C" },
      { from: "A", to: "C" },
      { from: "B", to: "C" },
    ]);
    expect(counts.get("c")).toBe(2);
  });

  it("matches names across conventions", () => {
    const counts = computeDependentCounts([
      { from: "Order-LookupService", to: "InventoryCheckService" },
      { from: "orderLookupService", to: "inventory-check-service" },
    ]);
    expect(counts.get("inventorycheckservice")).toBe(1);
  });

  it("ignores self-edges", () => {
    expect(computeDependentCounts([{ from: "A", to: "A" }]).size).toBe(0);
  });

  it("returns nothing for no edges", () => {
    expect(computeDependentCounts([]).size).toBe(0);
  });
});

describe("mergeFindings", () => {
  it("takes the risk rating from the Risk Agent and the rubric inputs from Discovery", () => {
    const { findings } = mergeFindings(discovery(), risk());

    const customer = findings.find((finding) => finding.serviceName === "CustomerAccountService");
    // Discovery said "high"; the Risk Agent, having consulted the tools, said
    // "critical". The risk agent's judgement wins.
    expect(customer?.riskLevel).toBe("critical");
    // The structured fields come from Discovery, which owns the inventory.
    expect(customer?.hasTestCoverageGap).toBe(true);
    expect(customer?.dataQualityIssueCount).toBe(2);
    expect(customer?.requiresMajorRestructuring).toBe(true);
  });

  it("falls back to Discovery's own rating for a service the Risk Agent omitted", () => {
    // A service can be missing from the ranking without the finding disappearing:
    // the inventory is Discovery's to report, not the Risk Agent's.
    const { findings } = mergeFindings(
      discovery(),
      risk({ ranked: [{ serviceName: "OrderLookupService", riskLevel: "medium", reasoning: "x" }] }),
    );

    const customer = findings.find((finding) => finding.serviceName === "CustomerAccountService");
    expect(customer?.riskLevel).toBe("high");
  });

  it("matches services across naming conventions instead of duplicating them", () => {
    const { findings } = mergeFindings(
      discovery(),
      risk({
        ranked: [
          { serviceName: "customer_account_service", riskLevel: "low", reasoning: "reassessed" },
        ],
      }),
    );

    const matches = findings.filter(
      (finding) => finding.serviceName.toLowerCase().replace(/[^a-z]/g, "") === "customeraccountservice",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.riskLevel).toBe("low");
  });

  it("keeps a service the Risk Agent found that Discovery never listed", () => {
    const { findings, undiscoveredServices } = mergeFindings(discovery(), risk());

    expect(undiscoveredServices).toEqual(["PaymentGatewayClient"]);
    const payment = findings.find((finding) => finding.serviceName === "PaymentGatewayClient");
    expect(payment?.riskLevel).toBe("high");
    // Discovery never reported it, so there are no structured rubric inputs for
    // it. Defaulting is the conservative reading: these are absences of evidence,
    // and inventing values would put fiction into the rubric's inputs.
    expect(payment?.hasTestCoverageGap).toBe(false);
    expect(payment?.dataQualityIssueCount).toBe(0);
  });
});

describe("buildPersistencePlan", () => {
  it("attaches the dependent count to the right finding", () => {
    // InventoryCheckService has to be in the inventory for a dependent count to
    // attach to it, so the fixture adds it — the point being tested is the wiring
    // from edges to the finding, not the fixture's service list.
    const plan = buildPersistencePlan({
      discovery: discovery({
        services: [
          {
            name: "InventoryCheckService",
            riskLevel: "high",
            riskFactors: ["synchronous reservation logic"],
            hasTestCoverageGap: true,
            dataQualityIssueCount: 0,
            requiresMajorRestructuring: false,
          },
          {
            name: "OrderLookupService",
            riskLevel: "low",
            riskFactors: [],
            hasTestCoverageGap: false,
            dataQualityIssueCount: 0,
            requiresMajorRestructuring: false,
          },
        ],
        dependencies: [
          { from: "PartnerCatalogFeed", to: "InventoryCheckService", type: "shared database" },
          { from: "OrderLookupService", to: "InventoryCheckService", type: "synchronous call" },
        ],
      }),
      risk: risk({ ranked: [{ serviceName: "InventoryCheckService", riskLevel: "high", reasoning: "x" }] }),
    });

    const inventory = plan.findings.find((finding) => finding.serviceName === "InventoryCheckService");
    const lookup = plan.findings.find((finding) => finding.serviceName === "OrderLookupService");

    expect(inventory?.dependentCount).toBe(2);
    // A leaf service that depends on others has no dependents of its own.
    expect(lookup?.dependentCount).toBe(0);
  });

  it("drops duplicate and self edges before they reach the table", () => {
    const plan = buildPersistencePlan({
      discovery: discovery({
        dependencies: [
          { from: "A", to: "B", type: "shared database" },
          { from: "A", to: "B", type: "shared database" },
          { from: "A", to: "A", type: "sync call" },
        ],
      }),
      risk: risk(),
    });

    // Normalization happens in the graph, but the plan must not reintroduce
    // duplicates if it is called directly.
    expect(plan.dependencies.length).toBeGreaterThan(0);
    expect(plan.dependencies.every((dependency) => dependency.fromService !== dependency.toService)).toBe(true);
  });

  it("carries the dependency type and evidence through to the row", () => {
    const plan = buildPersistencePlan({ discovery: discovery(), risk: risk() });
    const edge = plan.dependencies.find((dependency) => dependency.fromService === "CustomerAccountService");

    expect(edge?.type).toBe("sync_call");
    expect(edge?.toService).toBe("PostalVerificationApi");
  });
});

function createFakeAnalysisStore() {
  const findings: (StoredFinding & { runId: string; projectId: string })[] = [];
  const dependencies: (StoredDependency & { runId: string; projectId: string })[] = [];
  let sequence = 0;

  const store: AnalysisStore = {
    async replaceResults({ runId, projectId, findings: findingRows, dependencies: dependencyRows }) {
      // Mirrors the real store's contract: scoped to one run, idempotent for it,
      // and never touching another run's rows.
      for (let index = findings.length - 1; index >= 0; index -= 1) {
        if (findings[index]?.runId === runId) findings.splice(index, 1);
      }
      for (let index = dependencies.length - 1; index >= 0; index -= 1) {
        if (dependencies[index]?.runId === runId) dependencies.splice(index, 1);
      }

      for (const row of findingRows) {
        sequence += 1;
        findings.push({ ...row, id: `finding-${sequence}`, runId, projectId });
      }
      for (const row of dependencyRows) {
        sequence += 1;
        dependencies.push({ ...row, id: `dependency-${sequence}`, runId, projectId });
      }
    },

    async findFindings(projectId, runId) {
      return findings.filter((row) => row.runId === runId && row.projectId === projectId);
    },

    async findDependencies(projectId, runId) {
      return dependencies.filter((row) => row.runId === runId && row.projectId === projectId);
    },
  };

  return { store, findings, dependencies };
}

describe("persistAnalysis", () => {
  const input = {
    runId: "run-1",
    projectId: "project-1",
    discovery: discovery(),
    risk: risk(),
  };

  it("writes findings and dependencies", async () => {
    const fake = createFakeAnalysisStore();
    const plan = await persistAnalysis(fake.store, input);

    expect(fake.findings).toHaveLength(plan.findings.length);
    expect(fake.dependencies).toHaveLength(plan.dependencies.length);
    expect(fake.findings.length).toBeGreaterThan(0);
  });

  it("stamps every row with the run and project it belongs to", async () => {
    const fake = createFakeAnalysisStore();
    await persistAnalysis(fake.store, input);

    expect(fake.findings.every((row) => row.runId === "run-1" && row.projectId === "project-1")).toBe(true);
    expect(fake.dependencies.every((row) => row.runId === "run-1" && row.projectId === "project-1")).toBe(true);
  });

  it("is idempotent for the same run", async () => {
    const fake = createFakeAnalysisStore();
    const first = await persistAnalysis(fake.store, input);
    await persistAnalysis(fake.store, input);

    expect(fake.findings).toHaveLength(first.findings.length);
    expect(fake.dependencies).toHaveLength(first.dependencies.length);
  });

  it("never touches another run's results", async () => {
    // The per-run decision from M0: re-analysing a project adds a second, comparable
    // graph rather than overwriting the first.
    const fake = createFakeAnalysisStore();
    const first = await persistAnalysis(fake.store, input);
    await persistAnalysis(fake.store, { ...input, runId: "run-2" });

    const runOne = await fake.store.findFindings("project-1", "run-1");
    expect(runOne).toHaveLength(first.findings.length);
    expect(fake.findings.filter((row) => row.runId === "run-1")).toHaveLength(first.findings.length);
  });

  it("reads back only the rows for the requested run and project", async () => {
    const fake = createFakeAnalysisStore();
    await persistAnalysis(fake.store, input);
    await persistAnalysis(fake.store, { ...input, runId: "run-2", projectId: "project-2" });

    expect(await fake.store.findFindings("project-1", "run-2")).toEqual([]);
    expect((await fake.store.findFindings("project-1", "run-1")).length).toBeGreaterThan(0);
  });

  it("persists the dependency edges M4 will render", async () => {
    const fake = createFakeAnalysisStore();
    await persistAnalysis(fake.store, input);

    const edges = await fake.store.findDependencies("project-1", "run-1");
    expect(edges.map((edge) => `${edge.fromService}->${edge.toService}`)).toContain(
      "CustomerAccountService->PostalVerificationApi",
    );
  });
});

describe("NewFinding shape", () => {
  it("a finding carries every rubric input the scoring engine will read", () => {
    // A type-level guard written as a value test: if the shape loses one of these
    // fields, the rubric's inputs silently become undefined at runtime.
    const plan = buildPersistencePlan({ discovery: discovery(), risk: risk() });
    const finding: NewFinding | undefined = plan.findings[0];
    const dependency: NewDependency | undefined = plan.dependencies[0];

    expect(finding).toMatchObject({
      serviceName: expect.any(String),
      riskLevel: expect.any(String),
      riskFactors: expect.any(Array),
      hasTestCoverageGap: expect.any(Boolean),
      dataQualityIssueCount: expect.any(Number),
      requiresMajorRestructuring: expect.any(Boolean),
      dependentCount: expect.any(Number),
    });
    expect(dependency).toMatchObject({
      fromService: expect.any(String),
      toService: expect.any(String),
      type: expect.any(String),
    });
  });
});
