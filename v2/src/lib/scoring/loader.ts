import {
  architectureOutputSchema,
  comparisonOutputSchema,
  discoveryOutputSchema,
  riskAssessmentSchema,
} from "@/lib/agents/schemas";
import type {
  ArchitectureOutput,
  ComparisonOutput,
  DiscoveryOutput,
  RiskOutput,
} from "@/lib/agents/schemas";
import type { RunRecord } from "@/lib/agents/run";
import type { RunStore } from "@/lib/agents/run";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "@/lib/agents/stores";
import { createDrizzleOperationalStore, type OperationalStore } from "@/lib/operational/repository";
import { getLogger } from "@/lib/observability/logger";

import type { ScorecardExplanation } from "./explain";
import type { OperationalAdjustment, OperationalEntry, OperationalSignals } from "./operational";
import type { MigrationParametersInput, ParameterAssessment } from "./parameters";
import { describeRefinement, recomputeScorecard } from "./refine";
import {
  type Scorecard,
  type ScorecardInput,
  type ScoringDependency,
  type ScoringFinding,
} from "./rubric";
import type { RiskWeighting } from "./weights";
import type { MigrationAssumptions } from "./assumptions";

/**
 * The database boundary for scoring: persisted rows in, a scorecard out.
 *
 * This is the only part of the scoring path that touches a database, and it is
 * deliberately thin — every decision lives in the pure rubric. What it does
 * guarantee:
 *
 * 1. **No prose is parsed.** The Architecture/Risk/Comparison inputs come from the
 *    JSON columns M3 writes, re-validated against the same zod schemas that
 *    produced them. The narratives on the run row are never read here, so a score
 *    cannot drift from the findings it claims to rest on.
 * 2. **Nothing is re-derived.** Findings and edges are read as persisted; the
 *    dependent counts come from the column M3 computed, not from re-counting edges.
 * 3. **Owner scoping holds.** Both reads are owner-parameterised, so another
 *    session's project resolves to null rather than to a scorecard.
 * 4. **A malformed row is treated as absent, not fatal.** A run whose structured
 *    output predates the columns (or fails validation) still scores — the affected
 *    term is simply missing, and the evidence quality drops to say so.
 * 5. **Refinement is the only score path.** M5 loads the project's operational data
 *    and migration parameters and hands them to `recomputeScorecard()`, so there is
 *    one code path producing the five numbers rather than a "baseline" path and a
 *    "refined" path that could disagree. With neither input present, the refinement
 *    degenerates to the code-only estimate by construction, which is asserted.
 */

export type LoadedRefinement = {
  operational: OperationalSignals;
  adjustment: OperationalAdjustment;
  parameters: ParameterAssessment[];
  parametersInForce: MigrationParametersInput;
  /** True when the refined figures differ from the code-only baseline. */
  changed: boolean;
  /** One deterministic sentence describing what the refinement changed. */
  description: string;
};

/**
 * The run's structured outputs, re-validated against the schemas that produced
 * them. A field is absent when the run predates its column or the stored row fails
 * validation — the same "malformed is absent, not fatal" rule the scoring inputs
 * follow, so one bad column cannot take a page down.
 *
 * `discovery` is included here even though the rubric does not read it: the report
 * layer explains what was discovered, and it must consume the same validated
 * structure the rest of the pipeline does rather than reaching into the jsonb
 * column itself.
 */
export type ParsedRunOutputs = {
  discovery?: DiscoveryOutput;
  architecture?: ArchitectureOutput;
  risk?: RiskOutput;
  comparison?: ComparisonOutput;
};

export function readRunOutputs(run: RunRecord): ParsedRunOutputs {
  return {
    discovery: parseOrNull(discoveryOutputSchema, run.outputs.discovery, "discoveryOutput", run.id),
    architecture: parseOrNull(
      architectureOutputSchema,
      run.outputs.architecture,
      "architectureOutput",
      run.id,
    ),
    risk: parseOrNull(riskAssessmentSchema, run.outputs.risk, "riskOutput", run.id),
    comparison: parseOrNull(
      comparisonOutputSchema,
      run.outputs.comparison,
      "comparisonOutput",
      run.id,
    ),
  };
}

export type LoadedScorecard = {
  run: RunRecord;
  input: ScorecardInput;
  scorecard: Scorecard;
  explanation: ScorecardExplanation;
  /** The code-only estimate, so a UI can show the movement the refinement produced. */
  baseline: Scorecard;
  refinement: LoadedRefinement;
  /** The validated structured outputs behind the scores, for the report layer. */
  outputs: ParsedRunOutputs;
};

export type LoadOptions = {
  riskWeighting?: RiskWeighting;
  assumptions?: Partial<MigrationAssumptions>;
  /** Explicit operational entries, bypassing the store — used by tests and scripts. */
  entries?: OperationalEntry[];
  /** Explicit parameters, bypassing the store — used by tests and scripts. */
  parameters?: MigrationParametersInput;
};

/** Maps a persisted finding row onto the rubric's input shape. */
export function toScoringFinding(row: {
  serviceName: string;
  riskLevel: ScoringFinding["riskLevel"];
  hasTestCoverageGap: boolean;
  dataQualityIssueCount: number;
  requiresMajorRestructuring: boolean;
  dependentCount: number;
}): ScoringFinding {
  return {
    serviceName: row.serviceName,
    riskLevel: row.riskLevel,
    hasTestCoverageGap: row.hasTestCoverageGap,
    dataQualityIssueCount: row.dataQualityIssueCount,
    requiresMajorRestructuring: row.requiresMajorRestructuring,
    // Read from the persisted column rather than re-counted from the edges: M3
    // already derived it, and recomputing here would be a second implementation of
    // the same rule that could disagree with what the run recorded.
    dependentCount: row.dependentCount,
  };
}

function parseOrNull<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
  label: string,
  runId: string,
): T | undefined {
  if (value === null || value === undefined) return undefined;

  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    getLogger().warn({ runId, label }, "Persisted structured output failed validation; treating it as absent");
    return undefined;
  }
  return result.data;
}

export function buildScorecardInput(input: {
  findings: ScoringFinding[];
  dependencies: ScoringDependency[];
  run: RunRecord;
  options?: LoadOptions;
  /**
   * Already-validated outputs. Supplied by the loader, which parses them once and
   * also hands them to the report layer; omitted by callers that only have a run.
   */
  outputs?: ParsedRunOutputs;
}): ScorecardInput {
  const { run } = input;
  const outputs = input.outputs ?? readRunOutputs(run);

  const architecture = outputs.architecture;
  const risk = outputs.risk;
  const comparison = outputs.comparison;

  return {
    findings: input.findings,
    dependencies: input.dependencies,
    architecture: architecture
      ? {
          currentArchitectureLargelySound: architecture.currentArchitectureLargelySound,
          phasedPlan: architecture.phasedPlan.map((phase) => ({ phaseNumber: phase.phaseNumber })),
        }
      : undefined,
    risk: risk
      ? { ranked: risk.ranked.map((entry) => ({ serviceName: entry.serviceName, riskLevel: entry.riskLevel })), operationalDataAvailable: risk.operationalDataAvailable }
      : undefined,
    comparison: comparison
      ? { matched: comparison.matched, missed: comparison.missed, incorrect: comparison.incorrect }
      : undefined,
    assumptions: input.options?.assumptions,
    riskWeighting: input.options?.riskWeighting,
  };
}

async function loadFor(
  run: RunRecord,
  options: LoadOptions | undefined,
  stores: {
    analysis: ReturnType<typeof createDrizzleAnalysisStore>;
    operational: OperationalStore;
  },
): Promise<LoadedScorecard> {
  const findingRows = await stores.analysis.findFindings(run.projectId, run.id);
  const dependencyRows = await stores.analysis.findDependencies(run.projectId, run.id);

  // Parsed once here and shared: the scoring inputs consume three of the four, and
  // the report layer consumes all four, so parsing them again downstream would be
  // the same JSON validated twice with the same schema.
  const outputs = readRunOutputs(run);

  const scorecardInput = buildScorecardInput({
    findings: findingRows.map(toScoringFinding),
    dependencies: dependencyRows.map((dependency) => ({
      fromService: dependency.fromService,
      toService: dependency.toService,
      type: dependency.type,
    })),
    run,
    options,
    outputs,
  });

  // The refinement inputs, read as persisted. An explicit option wins so a test or a
  // script can recompute with a hypothetical file without writing one.
  const entries = options?.entries ?? (await stores.operational.listEntries(run.projectId));
  const parameters = options?.parameters ?? (await stores.operational.readParameters(run.projectId));

  const refined = recomputeScorecard({
    input: scorecardInput,
    entries,
    parameters,
    riskWeighting: options?.riskWeighting,
  });

  return {
    run,
    input: refined.input,
    scorecard: refined.scorecard,
    explanation: refined.explanation,
    baseline: refined.baseline,
    outputs,
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

/** The scorecard for one specific run, if this session owns it and it completed. */
export async function loadScorecardForRun(
  ownerId: string,
  runId: string,
  options?: LoadOptions,
  stores: {
    runs?: RunStore;
    analysis?: ReturnType<typeof createDrizzleAnalysisStore>;
    operational?: OperationalStore;
  } = {},
): Promise<LoadedScorecard | null> {
  const runs = stores.runs ?? createDrizzleRunStore();
  const analysis = stores.analysis ?? createDrizzleAnalysisStore();
  const operational = stores.operational ?? createDrizzleOperationalStore();

  const run = await runs.getRun(ownerId, runId);
  if (!run || run.status !== "complete") return null;

  return loadFor(run, options, { analysis, operational });
}

/** The scorecard for a project's most recent completed run. */
export async function loadScorecardForProject(
  ownerId: string,
  projectId: string,
  options?: LoadOptions,
  stores: {
    runs?: RunStore;
    analysis?: ReturnType<typeof createDrizzleAnalysisStore>;
    operational?: OperationalStore;
  } = {},
): Promise<LoadedScorecard | null> {
  const runs = stores.runs ?? createDrizzleRunStore();
  const analysis = stores.analysis ?? createDrizzleAnalysisStore();
  const operational = stores.operational ?? createDrizzleOperationalStore();

  const run = await runs.latestCompletedRun(ownerId, projectId);
  if (!run) return null;

  return loadFor(run, options, { analysis, operational });
}

