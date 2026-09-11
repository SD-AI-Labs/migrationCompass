import { OPERATIONAL_RISK, RISK_LEVEL_VALUES, round, type MigrationAssumptions } from "./assumptions";
import {
  computeOperationalAdjustment,
  describeSignals,
  emptyOperationalAdjustment,
  emptyOperationalSignals,
  type OperationalAdjustment,
} from "./operational";
import {
  assessEvidence,
  computeScorecard,
  computeEffort,
  computeReadiness,
  dataQualityPerService,
  restructuringShare,
  testCoverageGapShare,
  type Scorecard,
  type ScorecardInput,
} from "./rubric";
import { computeRiskWeights, type RiskWeighting } from "./weights";

/**
 * "Why is this score what it is?"
 *
 * Every headline number on the scorecard has to be decomposable into the
 * structured inputs that produced it — that is the plan's entire argument against
 * an LLM-generated score, so the explanation cannot be generated prose either. It
 * is arithmetic over the same persisted findings the score came from.
 *
 * Two jobs, one shape:
 *
 * - **For the UI**: labelled contributions a reader can scan, plus the
 *   assumptions and factors in force.
 * - **For debugging**: the raw inputs and the formula, so a surprising number can
 *   be traced without re-deriving the pipeline by hand.
 *
 * Additive scores carry contributions that sum to the value within a stated
 * tolerance, and `verifyContributions` checks that. Multiplicative ones (cost) are
 * marked non-additive and expose factors instead — pretending a product is a sum
 * would be worse than saying so.
 */

export const SCORE_NAMES = ["readiness", "risk", "effort", "cost", "time"] as const;
export type ScoreName = (typeof SCORE_NAMES)[number];

export const SCORE_LABELS: Record<ScoreName, string> = {
  readiness: "Migration Readiness",
  risk: "Risk",
  effort: "Effort",
  cost: "Cost",
  time: "Time",
};

/** Rounding drift across four or five displayed terms, not a modelling allowance. */
export const CONTRIBUTION_TOLERANCE = 0.05;

export type Contribution = {
  key: string;
  label: string;
  /** Signed: penalties are negative, credits and weighted terms positive. */
  value: number;
  detail: string;
};

export type ExplanationFactor = {
  label: string;
  value: string;
  note: string;
};

export type ScoreExplanation = {
  score: ScoreName;
  label: string;
  value: number;
  unit: string;
  formatted: string;
  summary: string;
  /** The formula as written, so the arithmetic is inspectable. */
  formula: string;
  contributions: Contribution[];
  /** True when the contributions are meant to sum to `value`. */
  additive: boolean;
  total: number;
  tolerance: number;
  factors: ExplanationFactor[];
  /** The structured inputs behind the number, for debugging. */
  inputs: Record<string, string | number>;
};

export type ScorecardExplanation = {
  scores: Record<ScoreName, ScoreExplanation>;
  evidence: Scorecard["confidence"]["evidence"];
  confidenceLabel: string;
  assumptions: MigrationAssumptions;
  riskWeighting: RiskWeighting;
  /**
   * The operational adjustment behind Risk, when any was applied.
   *
   * Exposed on the explanation rather than only on the scorecard because a reader
   * asking "why is this 62?" needs to see the measured-data movement in the same
   * place as the contributions it modified.
   */
  operational: OperationalAdjustment | null;
};

export function contributionsSum(explanation: ScoreExplanation): number {
  return round(
    explanation.contributions.reduce((sum, contribution) => sum + contribution.value, 0),
    4,
  );
}

/**
 * True when the displayed contributions account for the score. Meaningful only for
 * additive scores; a multiplicative score has no sum to check, and pretending
 * otherwise would be a test that cannot fail.
 */
export function verifyContributions(
  explanation: ScoreExplanation,
  tolerance = explanation.tolerance,
): boolean {
  if (!explanation.additive) return true;
  return Math.abs(contributionsSum(explanation) - explanation.value) <= tolerance;
}

function riskExplanation(
  input: ScorecardInput,
  weighting: RiskWeighting,
  scorecard: Scorecard,
): ScoreExplanation {
  const weights = computeRiskWeights(
    input.findings.map((finding) => ({
      serviceName: finding.serviceName,
      riskLevel: finding.riskLevel,
      dependentCount: finding.dependentCount,
    })),
    weighting,
  );

  const contributions: Contribution[] = weights.map((weight) => ({
    key: weight.serviceName,
    label: weight.serviceName,
    value: round(weight.contribution, 4),
    detail:
      `${weight.riskLevel} (${weight.riskValue}/100) × ${round(weight.share * 100, 1)}% weight` +
      (weighting === "dependency" ? ` · raw weight ${weight.weight} from ${weight.weight - 1} dependent(s)` : ""),
  }));

  // The operational adjustment is shown as its own contributions rather than folded
  // into the service rows: "this code is riskier than it looks" and "this code
  // misbehaves in production" are different claims, and a reader is entitled to see
  // which one moved the number.
  const operational: OperationalAdjustment = input.operational
    ? computeOperationalAdjustment(input.operational)
    : emptyOperationalAdjustment(emptyOperationalSignals());

  for (const term of operational.terms) {
    contributions.push({
      key: `operational.${term.key}`,
      label: term.label,
      value: term.value,
      detail: `${term.detail} · measured data, not model output`,
    });
  }

  // Biggest driver first: the question an explanation answers is "why is this
  // number what it is", and that answer starts with the service moving it most.
  // Ties break on name, so the order is stable across runs.
  contributions.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  const summed = round(
    contributions.reduce((sum, contribution) => sum + contribution.value, 0),
    2,
  );

  // The rubric clamps Risk to 0–100 and the operational adjustment is bounded, so
  // the displayed rows can legitimately disagree with the final figure. When that
  // happens the difference is shown as its own row rather than hidden, because the
  // alternative is a contribution table that does not add up.
  const boundingRow = round(scorecard.risk - summed, 2);
  const withBounds =
    Math.abs(boundingRow) > 0.005
      ? [
          ...contributions,
          {
            key: "bounds",
            label: "Clamped to 0–100",
            value: boundingRow,
            detail: "The weighted sum plus the bounded operational adjustment was clamped to the rubric's range.",
          },
        ]
      : contributions;

  const total = round(
    withBounds.reduce((sum, contribution) => sum + contribution.value, 0),
    2,
  );

  return {
    score: "risk",
    label: SCORE_LABELS.risk,
    value: scorecard.risk,
    unit: "/ 100",
    formatted: `${scorecard.risk.toFixed(1)} / 100`,
    summary:
      input.findings.length === 0
        ? "No services were persisted, so there is nothing to aggregate — the score is 0 rather than an invented midpoint."
        : `Weighted mean of ${input.findings.length} service risk levels, ` +
          `${weighting === "dependency" ? "weighted by how many services depend on each" : "equal-weighted"}` +
          (operational.applied
            ? `, then adjusted ${operational.delta > 0 ? "+" : ""}${operational.delta} points by measured operational data.`
            : "."),
    formula:
      operational.applied
        ? "Σ (normalized weight × risk level value) + bounded operational adjustment"
        : "Σ (normalized weight × risk level value)",
    contributions: withBounds,
    additive: true,
    total,
    tolerance: CONTRIBUTION_TOLERANCE,
    factors: [
      {
        label: "Weighting mode",
        value: weighting === "dependency" ? "Dependency-weighted" : "Equal-weighted",
        note:
          "Dependency weighting raises the influence of services other services depend on. With no edges " +
          "recorded it is identical to equal weighting by construction.",
      },
      {
        label: "Risk level values",
        value: "critical 100 · high 75 · medium 50 · low 25",
        note: "The documented mapping from the scoring rubric.",
      },
      ...(operational.applied
        ? [
            {
              label: "Operational data",
              value: `${operational.delta > 0 ? "+" : ""}${operational.delta} points`,
              note:
                `${describeSignals(operational.signals)} — parsed deterministically from the supplied files, ` +
                `bounded to ±${OPERATIONAL_RISK.maxAdjustment} points. No model was called.`,
            },
          ]
        : []),
    ],
    inputs: {
      services: input.findings.length,
      dependencies: input.dependencies.length,
      riskWeighting: weighting,
      riskDelta: operational.delta,
      operationalFiles: operational.signals.entries,
    },
  };
}

function effortExplanation(input: ScorecardInput, scorecard: Scorecard): ScoreExplanation {
  const breakdown = computeEffort({
    findings: input.findings,
    phaseCount: input.architecture?.phasedPlan.length ?? 0,
    riskScore: scorecard.risk,
    assumptions: input.assumptions,
  });

  const contributions: Contribution[] = [
    {
      key: "serviceCount",
      label: "Service count",
      value: round(breakdown.terms.serviceCount * 9, 4),
      detail: `${input.findings.length} services, normalized to ${round(breakdown.normalized.serviceCount * 100, 1)}% of ${scorecard.assumptions.referenceServiceCount} · weight 0.3`,
    },
    {
      key: "phaseCount",
      label: "Migration phases",
      value: round(breakdown.terms.phaseCount * 9, 4),
      detail: `${scorecard.counts.phases} phases, normalized to ${round(breakdown.normalized.phaseCount * 100, 1)}% of ${scorecard.assumptions.referencePhaseCount} · weight 0.2`,
    },
    {
      key: "risk",
      label: "Risk",
      value: round(breakdown.terms.risk * 9, 4),
      detail: `risk ${scorecard.risk}/100 → ${round(breakdown.normalized.risk * 100, 1)}% · weight 0.3`,
    },
    {
      key: "restructuring",
      label: "Major restructuring",
      value: round(breakdown.terms.restructuring * 9, 4),
      detail: `${round(breakdown.normalized.restructuring * 100, 1)}% of services need major restructuring · weight 0.2`,
    },
  ];

  const total = round(
    1 + contributions.reduce((sum, contribution) => sum + contribution.value, 0),
    2,
  );

  return {
    score: "effort",
    label: SCORE_LABELS.effort,
    value: scorecard.effort,
    unit: "/ 10",
    formatted: `${scorecard.effort.toFixed(1)} / 10`,
    summary:
      "Four weighted terms mapped onto 1–10: service count (0.3), migration phases (0.2), risk (0.3), " +
      "major restructuring (0.2), with a floor of 1.",
    formula: "1 + 9 × (0.3·serviceCount + 0.2·phaseCount + 0.3·risk + 0.2·restructuring)",
    contributions: [
      { key: "base", label: "Floor", value: 1, detail: "The documented minimum effort score" },
      ...contributions,
    ],
    additive: true,
    total,
    tolerance: CONTRIBUTION_TOLERANCE,
    factors: [],
    inputs: {
      raw: round(breakdown.raw, 4),
      services: input.findings.length,
      phases: scorecard.counts.phases,
      risk: scorecard.risk,
      restructuringShare: round(breakdown.normalized.restructuring, 4),
    },
  };
}

function timeExplanation(input: ScorecardInput, scorecard: Scorecard): ScoreExplanation {
  const { time } = scorecard;
  const band = time.band;
  void input;

  return {
    score: "time",
    label: SCORE_LABELS.time,
    value: time.weeksMid,
    unit: "weeks",
    formatted: `${time.weeksMin}–${time.weeksMax} weeks`,
    summary:
      `Derived from Effort (${scorecard.effort}/10) via the documented band ${band.label}` +
      (time.teamFactor === 1
        ? ", unadjusted because the team size matches the reference."
        : `, adjusted ÷√(team ÷ reference) = ÷${time.teamFactor}.`),
    formula: "band(effort) → weeks, ÷ √(teamSize / referenceTeamSize)",
    // Empty on purpose: a band lookup is not a sum of parts, and displaying
    // "contributions" that do not add up to the headline number would be worse
    // than displaying none. The descriptive pieces live in `factors`.
    contributions: [],
    additive: false,
    total: time.weeksMid,
    tolerance: CONTRIBUTION_TOLERANCE,
    factors: [
      {
        label: "Band applied",
        value: band.label,
        note: `Effort ${scorecard.effort} falls in ${band.minEffort}–${band.maxEffort}, stated as ${band.label} in the plan.`,
      },
      {
        label: "Range",
        value: `${time.weeksMin}–${time.weeksMax} weeks`,
        note: "The band's documented weeks, with the monotonic floor applied so a higher effort never reports a shorter timeline.",
      },
      {
        label: "Team-size adjustment",
        value: `÷ ${time.teamFactor}`,
        note:
          `√(${scorecard.assumptions.teamSize} ÷ ${scorecard.assumptions.defaultTeamSize}) — sublinear, ` +
          "so headcount helps but not proportionally, and a smaller team takes longer.",
      },
    ],
    inputs: {
      effort: scorecard.effort,
      bandMinWeeks: band.minWeeks,
      bandMaxWeeks: band.maxWeeks,
      weeksMid: time.weeksMid,
      teamFactor: time.teamFactor,
    },
  };
}

function costExplanation(input: ScorecardInput, scorecard: Scorecard): ScoreExplanation {
  const currency = scorecard.assumptions.currency;

  return {
    score: "cost",
    label: SCORE_LABELS.cost,
    value: scorecard.cost,
    unit: currency,
    formatted: `${currency} ${Math.round(scorecard.cost).toLocaleString("en-US")}`,
    summary:
      `${scorecard.personWeeks} person-weeks (${scorecard.time.weeksMid} weeks × ${scorecard.assumptions.teamSize} ` +
      `engineers) × ${currency} ${scorecard.assumptions.weeklyRate.toLocaleString("en-US")} per engineer-week.`,
    formula: "duration × teamSize × weeklyRate",
    contributions: [],
    // A product, not a sum. Exposed as factors instead of faking an additive
    // decomposition across five identical per-engineer rows.
    additive: false,
    total: scorecard.cost,
    tolerance: CONTRIBUTION_TOLERANCE,
    factors: [
      {
        label: "Duration",
        value: `${scorecard.time.weeksMid} weeks`,
        note: "The representative (mid) estimate from the Time score.",
      },
      {
        label: "Team size",
        value: `${scorecard.assumptions.teamSize} engineers`,
        note: "Multiplies total human effort — an assumption, adjustable.",
      },
      {
        label: "Blended weekly rate",
        value: `${currency} ${scorecard.assumptions.weeklyRate.toLocaleString("en-US")}`,
        note: "Per engineer-week — an assumption, adjustable.",
      },
      {
        label: "Person-weeks",
        value: `${scorecard.personWeeks}`,
        note: "Duration × team size: the total engineering effort the estimate implies.",
      },
    ],
    inputs: {
      personWeeks: scorecard.personWeeks,
      durationWeeks: scorecard.time.weeksMid,
      teamSize: scorecard.assumptions.teamSize,
      weeklyRate: scorecard.assumptions.weeklyRate,
    },
  };
}

function readinessExplanation(input: ScorecardInput, scorecard: Scorecard): ScoreExplanation {
  const breakdown = computeReadiness({
    findings: input.findings,
    architecture: input.architecture,
    riskScore: scorecard.risk,
    effort: scorecard.effort,
  });

  const terms = breakdown.terms;
  const contributions: Contribution[] = [
    { key: "base", label: "Baseline", value: round(terms.base, 2), detail: "The starting point every system begins from" },
    {
      key: "architectureSound",
      label: "Architecture largely sound",
      value: round(terms.architectureSound, 2),
      detail: input.architecture
        ? input.architecture.currentArchitectureLargelySound
          ? "The Architecture Agent stated the current architecture is largely sound"
          : "The Architecture Agent did not state the current architecture is largely sound"
        : "No architecture output was persisted for this run",
    },
    {
      key: "lowRiskCredit",
      label: "Low-risk credit",
      value: round(terms.lowRiskCredit, 2),
      detail: `(1 − risk ${scorecard.risk}/100) × 20`,
    },
    {
      key: "effortPenalty",
      label: "Effort penalty",
      value: round(-terms.effortPenalty, 2),
      detail: `Effort ${scorecard.effort}/10`,
    },
    {
      key: "restructuringPenalty",
      label: "Restructuring penalty",
      value: round(-terms.restructuringPenalty, 2),
      detail: `${round(restructuringShare(input.findings) * 100, 1)}% of services need major restructuring`,
    },
    {
      key: "testCoveragePenalty",
      label: "Test-coverage penalty",
      value: round(-terms.testCoveragePenalty, 2),
      detail: `${round(testCoverageGapShare(input.findings) * 100, 1)}% of services have a coverage gap`,
    },
    {
      key: "dataQualityPenalty",
      label: "Data-quality penalty",
      value: round(-terms.dataQualityPenalty, 2),
      detail: `${round(dataQualityPerService(input.findings), 2)} issues per service, saturating at 4`,
    },
  ];

  const total = round(
    contributions.reduce((sum, contribution) => sum + contribution.value, 0),
    2,
  );

  return {
    score: "readiness",
    label: SCORE_LABELS.readiness,
    value: scorecard.readiness,
    unit: "/ 100",
    formatted: `${scorecard.readiness.toFixed(1)} / 100`,
    summary:
      "Inverse-weighted composite: high risk, high effort, restructuring, coverage gaps and data-quality " +
      "issues pull it down; an explicit 'architecture is largely sound' finding pulls it up.",
    formula: "base + architecture + lowRisk − effort − restructuring − coverage − dataQuality",
    contributions,
    additive: true,
    total,
    tolerance: CONTRIBUTION_TOLERANCE,
    factors: [],
    inputs: {
      risk: scorecard.risk,
      effort: scorecard.effort,
      services: input.findings.length,
      architectureSound: String(input.architecture?.currentArchitectureLargelySound ?? "unknown"),
    },
  };
}

/** The whole scorecard, explained. Deterministic, and derived from the same inputs. */
export function explainScorecard(input: ScorecardInput): ScorecardExplanation {
  const scorecard = computeScorecard(input);
  const weighting = input.riskWeighting ?? scorecard.riskWeighting;

  return {
    scores: {
      readiness: readinessExplanation(input, scorecard),
      risk: riskExplanation(input, weighting, scorecard),
      effort: effortExplanation(input, scorecard),
      cost: costExplanation(input, scorecard),
      time: timeExplanation(input, scorecard),
    },
    evidence: assessEvidence(input),
    confidenceLabel: scorecard.confidence.label,
    assumptions: scorecard.assumptions,
    riskWeighting: weighting,
    operational: scorecard.operational.applied ? scorecard.operational : null,
  };
}

export { RISK_LEVEL_VALUES };
