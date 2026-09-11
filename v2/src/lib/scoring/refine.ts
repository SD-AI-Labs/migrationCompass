import { type MigrationAssumptions } from "./assumptions";
import { explainScorecard, type ScorecardExplanation } from "./explain";
import {
  deriveOperationalSignals,
  type OperationalAdjustment,
  type OperationalEntry,
  type OperationalSignals,
} from "./operational";
import {
  EMPTY_PARAMETERS,
  assessParameters,
  assumptionsFromParameters,
  hasAnyParameter,
  validateParameters,
  type MigrationParametersInput,
  type ParameterAssessment,
} from "./parameters";
import { computeScorecard, type Scorecard, type ScorecardInput } from "./rubric";
import type { RiskWeighting } from "./weights";

/**
 * `recomputeScorecard()` — the "Refine these estimates" path.
 *
 * ## What this is
 *
 * A **deterministic, synchronous, LLM-free, network-free, vector-free**
 * recalculation of the scorecard from inputs the product already has: the
 * structured findings and dependency edges persisted for a run, plus — optionally —
 * operational data and migration parameters the user supplied afterwards.
 *
 * ## What it is not
 *
 * It is not a small analysis run, and it cannot become one. There is no model
 * client, no embedder, no retriever, and no database in this module's import graph,
 * so "recalculation makes zero LLM calls" is a property of the file rather than a
 * promise about the call sites. `refine.test.ts` asserts that two ways: a
 * call-counting LLM/embedding stub that must never be invoked, and a scan of this
 * module's own imports.
 *
 * ## The separation the plan requires
 *
 * ```
 *   Run analysis            → agent/LLM workflow   (expensive, explicit, re-runs the agents)
 *   Refine these estimates  → this module          (free, instant, re-runs the formula)
 * ```
 *
 * The narrative findings — Discovery, Architecture, Risk, Comparison prose, and the
 * per-service findings themselves — are **inputs** here and are never produced,
 * regenerated, or modified. A refinement changes the five numbers and nothing else;
 * the user is told plainly that the narratives still describe the original run.
 *
 * ## Why the fields come in as data
 *
 * `entries` is the validated operational-entry list (or nothing), and `parameters`
 * is the validated parameter set (or nothing). Neither is a file or a form: parsing
 * and validation happen at the edge so a malformed upload cannot reach the
 * arithmetic, and so this function stays pure enough to test with literals.
 */

export type RefineRequest = {
  /** The structured findings, edges and stage outputs — the same input M4 scores. */
  input: ScorecardInput;
  /** Validated operational entries. Empty means the code-only baseline. */
  entries?: OperationalEntry[];
  /** Validated migration parameters. Absent means the defaults stay in force. */
  parameters?: MigrationParametersInput;
  /** Optional weighting override, so both Risk weightings can be compared on one run. */
  riskWeighting?: RiskWeighting;
};

export type RefinedScorecard = {
  /**
   * The exact input the refined numbers came from — operational signals and the
   * parameter-derived assumptions included. Persisted nowhere, but handed to the
   * explanation and to any caller that wants to reproduce the figure.
   */
  input: ScorecardInput;
  /** What the scorecard was before refinement: the code-only estimate. */
  baseline: Scorecard;
  /** The refined scorecard. Identical to `baseline` when nothing was supplied. */
  scorecard: Scorecard;
  explanation: ScorecardExplanation;
  /** The derived signals, so a UI can state what was measured. */
  operational: OperationalSignals;
  /** The bounded Risk adjustment and its terms. */
  adjustment: OperationalAdjustment;
  /** Budget/timeline/environment compared against the computed estimate. */
  parameters: ParameterAssessment[];
  parametersInForce: MigrationParametersInput;
  assumptions: MigrationAssumptions;
  /** True when the refined figures differ from the code-only baseline. */
  changed: boolean;
};

/**
 * Recomputes the five scores. Same input, same output, every time — no clock, no
 * randomness, no I/O, no ordering dependence.
 */
export function recomputeScorecard(request: RefineRequest): RefinedScorecard {
  const entries = request.entries ?? [];
  const parameters = request.parameters ?? EMPTY_PARAMETERS;

  // Derived once, from the validated entries. Nothing downstream reads raw text.
  const operational = deriveOperationalSignals(entries);

  // The parameter→assumption mapping lives in `parameters.ts`; the rubric's formula
  // is untouched, so no constant is restated anywhere near the UI.
  const assumptions = assumptionsFromParameters(parameters, request.input.assumptions);

  // Fresh objects rather than mutation: the caller's input is the record of what the
  // run produced, and a recalculation must not be able to edit it.
  const refinedInput: ScorecardInput = {
    ...request.input,
    assumptions,
    operational,
    ...(request.riskWeighting !== undefined ? { riskWeighting: request.riskWeighting } : {}),
  };

  const baseline = computeScorecard({ ...request.input, operational: undefined });
  const scorecard = computeScorecard(refinedInput);

  return {
    input: refinedInput,
    baseline,
    scorecard,
    explanation: explainScorecard(refinedInput),
    operational,
    adjustment: scorecard.operational,
    parameters: assessParameters(parameters, scorecard),
    parametersInForce: parameters,
    assumptions: scorecard.assumptions,
    changed: !sameScores(baseline, scorecard),
  };
}

/** Whether two scorecards report the same five numbers. */
export function sameScores(left: Scorecard, right: Scorecard): boolean {
  return (
    left.readiness === right.readiness &&
    left.risk === right.risk &&
    left.effort === right.effort &&
    left.cost === right.cost &&
    left.time.weeksMin === right.time.weeksMin &&
    left.time.weeksMax === right.time.weeksMax
  );
}

/**
 * A one-line, deterministic statement of what a refinement changed.
 *
 * Written here rather than in the component so the same sentence is used by the
 * UI and by the demo script, and so it is covered by a test.
 */
export function describeRefinement(refined: RefinedScorecard): string {
  const parts: string[] = [];

  if (refined.operational.available) {
    parts.push(
      `${refined.operational.entries} operational data file(s) parsed — Risk ` +
        `${refined.adjustment.delta === 0 ? "unchanged" : `${refined.adjustment.delta > 0 ? "+" : ""}${refined.adjustment.delta} points`}`,
    );
  }

  if (hasAnyParameter(refined.parametersInForce)) {
    parts.push("migration parameters applied");
  }

  if (parts.length === 0) {
    return "No operational data or migration parameters have been supplied, so these are code-only estimates.";
  }

  parts.push("the narrative findings still describe the original analysis run");
  return `${parts.join("; ")}.`;
}

export { validateParameters, EMPTY_PARAMETERS };
export type { MigrationParametersInput, ParameterAssessment, OperationalEntry };
