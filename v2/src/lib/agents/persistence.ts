import type { Dependency, DependencyType, DiscoveryOutput, RiskLevel, RiskOutput } from "./schemas";
import { normalizeDependencies } from "./schemas";

/**
 * Turns the agents' structured output into the rows M4 will read.
 *
 * This is the last place where anything about the analysis is still in memory.
 * Everything downstream — the dependency graph, the rubric, the scorecard —
 * reads these rows and never re-derives them, which is the plan's explicit
 * requirement: the scoring engine must not be reconstructing graph topology.
 */

export type NewFinding = {
  serviceName: string;
  riskLevel: RiskLevel;
  riskFactors: string[];
  recommendation: string | null;
  hasTestCoverageGap: boolean;
  dataQualityIssueCount: number;
  requiresMajorRestructuring: boolean;
  /** Derived from the dependency edges, not from a model's opinion. */
  dependentCount: number;
};

export type NewDependency = {
  fromService: string;
  toService: string;
  type: DependencyType;
  evidence: string | null;
};

export type StoredFinding = NewFinding & { id: string };
export type StoredDependency = NewDependency & { id: string };

export type PersistencePlan = {
  findings: NewFinding[];
  dependencies: NewDependency[];
  /**
   * Services the Risk Agent rated that Discovery never listed. Surfaced rather
   * than swallowed: it means the two agents disagree about the inventory, which
   * is worth seeing, and dropping the risk agent's finding silently would lose
   * the only judgement made about that service.
   */
  undiscoveredServices: string[];
};

/** Case- and punctuation-insensitive, matching how the tools resolve service names. */
export function normalizeServiceKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * In-degree per service, counting *distinct dependents* rather than edges.
 *
 * The distinction matters and is easy to get wrong: a service called by
 * InventoryCheckService from three different call sites has one dependent, not
 * three. Counting edges would make a chatty neighbour look like a load-bearing
 * hub, and this number is intended to weight risk by blast radius.
 *
 * Equal weighting is the M0/schema default; the plan flags dependency-weighted
 * risk as the Phase-5 refinement this number exists to enable.
 */
export function computeDependentCounts(edges: { from: string; to: string }[]): Map<string, number> {
  const dependents = new Map<string, Set<string>>();

  for (const edge of edges) {
    const target = normalizeServiceKey(edge.to);
    const source = normalizeServiceKey(edge.from);
    if (target.length === 0 || source.length === 0 || target === source) continue;

    const existing = dependents.get(target) ?? new Set<string>();
    existing.add(source);
    dependents.set(target, existing);
  }

  return new Map([...dependents.entries()].map(([service, sources]) => [service, sources.size]));
}

/**
 * Combines Discovery's inventory (which carries the rubric's structured inputs)
 * with the Risk Agent's judgement (which carries the risk level).
 *
 * Discovery owns the service inventory and the three structured fields; the Risk
 * Agent owns the risk rating, because it is the one that consulted operational
 * signals. Where they disagree about a service name, the match is made on a
 * normalized key so "Order-LookupService" and "orderLookupService" are one
 * service rather than two findings for the same thing.
 */
export function mergeFindings(discovery: DiscoveryOutput, risk: RiskOutput): {
  findings: Omit<NewFinding, "dependentCount">[];
  undiscoveredServices: string[];
} {
  const riskByService = new Map(
    risk.ranked.map((entry) => [normalizeServiceKey(entry.serviceName), entry]),
  );

  const findings = discovery.services.map((service) => {
    const rated = riskByService.get(normalizeServiceKey(service.name));
    return {
      serviceName: service.name,
      riskLevel: (rated?.riskLevel ?? service.riskLevel) as RiskLevel,
      riskFactors: service.riskFactors,
      recommendation: service.recommendation ?? null,
      hasTestCoverageGap: service.hasTestCoverageGap,
      dataQualityIssueCount: service.dataQualityIssueCount,
      requiresMajorRestructuring: service.requiresMajorRestructuring,
    };
  });

  const known = new Set(discovery.services.map((service) => normalizeServiceKey(service.name)));
  const undiscoveredServices: string[] = [];

  for (const entry of risk.ranked) {
    const key = normalizeServiceKey(entry.serviceName);
    if (known.has(key)) continue;
    known.add(key);
    undiscoveredServices.push(entry.serviceName);

    findings.push({
      serviceName: entry.serviceName,
      riskLevel: entry.riskLevel,
      // The Risk Agent's reasoning is the only evidence that exists for this
      // service, so it is carried as the risk factor rather than discarded.
      riskFactors: [entry.reasoning],
      recommendation: entry.reasoning,
      // Discovery never reported this service, so it has no structured rubric
      // inputs. Defaulting to "no gap / no known data issues" is the conservative
      // reading: these are absences of evidence, not evidence of absence, and
      // inventing values here would put fiction into the rubric's inputs.
      hasTestCoverageGap: false,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
    });
  }

  return { findings, undiscoveredServices };
}

export function toNewDependencies(dependencies: Dependency[]): NewDependency[] {
  return dependencies.map((edge) => ({
    fromService: edge.from,
    toService: edge.to,
    type: edge.type,
    evidence: edge.evidence ?? null,
  }));
}

export function buildPersistencePlan(input: {
  discovery: DiscoveryOutput;
  risk: RiskOutput;
}): PersistencePlan {
  // Normalized here as well as in the graph. The graph cleans edges where they
  // enter the pipeline, but this function decides what reaches the table, and a
  // duplicate or self-edge is exactly the kind of noise that would double-count in
  // a risk weight — so it is not left to the caller to have remembered.
  const dependencies = toNewDependencies(normalizeDependencies(input.discovery.dependencies));
  const counts = computeDependentCounts(
    dependencies.map((dependency) => ({
      from: dependency.fromService,
      to: dependency.toService,
    })),
  );
  const merged = mergeFindings(input.discovery, input.risk);

  return {
    dependencies,
    undiscoveredServices: merged.undiscoveredServices,
    findings: merged.findings.map((finding) => ({
      ...finding,
      dependentCount: counts.get(normalizeServiceKey(finding.serviceName)) ?? 0,
    })),
  };
}

/**
 * Storage port for analysis results.
 *
 * `replaceResults` is scoped to a single run id and is idempotent for that run.
 * It is not a truncate: another run's findings and edges are never touched, which
 * is the M0 decision that dependencies are per-run — re-analysing a project adds
 * a comparable second graph rather than overwriting the first.
 */
export type AnalysisStore = {
  replaceResults(input: {
    runId: string;
    projectId: string;
    findings: NewFinding[];
    dependencies: NewDependency[];
  }): Promise<void>;
  findFindings(projectId: string, runId: string): Promise<StoredFinding[]>;
  findDependencies(projectId: string, runId: string): Promise<StoredDependency[]>;
};

export async function persistAnalysis(
  store: AnalysisStore,
  input: { runId: string; projectId: string; discovery: DiscoveryOutput; risk: RiskOutput },
): Promise<PersistencePlan> {
  const plan = buildPersistencePlan({ discovery: input.discovery, risk: input.risk });

  await store.replaceResults({
    runId: input.runId,
    projectId: input.projectId,
    findings: plan.findings,
    dependencies: plan.dependencies,
  });

  return plan;
}
