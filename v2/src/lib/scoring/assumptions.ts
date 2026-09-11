/**
 * Every number the rubric treats as an assumption, in one file, visible.
 *
 * The plan's requirement is specific: cost and time must be "explicitly presented
 * as assumptions the user can see and adjust, not hidden constants". That is only
 * true if the constants live somewhere a UI can read and a caller can override —
 * which is what this module is for. A `WEEKS_PER_MONTH` buried in a formula is a
 * hidden constant even if it is commented.
 *
 * Nothing here is computed from a model. Changing any value changes the score
 * deterministically and nothing else.
 */

/** Mirrors the `risk_level` column; redeclared so the scoring core has no DB import. */
export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The plan's documented mapping: Critical=100 / High=75 / Medium=50 / Low=25. */
export const RISK_LEVEL_VALUES: Record<RiskLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Effort term weights, exactly as documented:
 * `normalize(serviceCount)×0.3 + normalize(phaseCount)×0.2 + (risk/100)×0.3 + restructuring×0.2`
 */
export const EFFORT_WEIGHTS = {
  serviceCount: 0.3,
  phaseCount: 0.2,
  risk: 0.3,
  restructuring: 0.2,
} as const;

/**
 * Readiness term weights. Additive, with a base rather than a ceiling so the
 * architecture signal can genuinely pull the score *up* as the plan requires —
 * a base of 100 would make "current architecture is largely sound" a no-op.
 *
 * Maximum reachable: 55 + 25 + 20 = 100. Minimum reachable on real input: 10.
 */
export const READINESS_WEIGHTS = {
  base: 55,
  architectureSound: 25,
  lowRiskCredit: 20,
  effortPenalty: 15,
  restructuringPenalty: 15,
  testCoveragePenalty: 10,
  dataQualityPenalty: 5,
} as const;

/** Cap on the data-quality penalty: issues-per-service at or above this scores the full penalty. */
export const DATA_QUALITY_SATURATION_PER_SERVICE = 4;

export type TimeBand = {
  /** Inclusive lower effort bound. */
  minEffort: number;
  /** Inclusive upper effort bound, except for the final band which is capped at 10. */
  maxEffort: number;
  minWeeks: number;
  maxWeeks: number;
  /** How the plan states the band, shown to the user verbatim. */
  label: string;
};

/**
 * The plan's documented bands, unchanged. Note that the raw table overlaps
 * (effort 3–4 reaches 16 weeks, effort 5–6 starts at 13 weeks); the interpolation
 * in `rubric.ts` applies a monotonic floor so a higher effort can never produce a
 * shorter estimate, while staying inside each band's documented range.
 */
export const TIME_BANDS: TimeBand[] = [
  { minEffort: 1, maxEffort: 2, minWeeks: 4, maxWeeks: 8, label: "4–8 weeks" },
  { minEffort: 2, maxEffort: 4, minWeeks: 8, maxWeeks: 16, label: "8–16 weeks" },
  { minEffort: 4, maxEffort: 6, minWeeks: 13, maxWeeks: 26, label: "3–6 months" },
  { minEffort: 6, maxEffort: 8, minWeeks: 26, maxWeeks: 39, label: "6–9 months" },
  { minEffort: 8, maxEffort: 10, minWeeks: 39, maxWeeks: 52, label: "9–12+ months" },
];

export const WEEKS_PER_MONTH = 4.345;

export type MigrationAssumptions = {
  /** Engineers available. Feeds the cost calculation and the sublinear time adjustment. */
  teamSize: number;
  /** Blended weekly cost per engineer, in `currency`. User-adjustable. */
  weeklyRate: number;
  /** The team size the time bands are calibrated against. */
  defaultTeamSize: number;
  /** Service count at which the service-count normalization saturates. */
  referenceServiceCount: number;
  /** Phase count at which the phase normalization saturates. */
  referencePhaseCount: number;
  currency: string;
  /**
   * Migration-parameter inputs that are *recorded and shown* but do not enter the
   * arithmetic. Kept on the assumptions object so a scorecard can state what target
   * it describes without a second, parallel config type.
   */
  targetEnvironment?: string;
  provider?: string;
};

/**
 * Defaults, with the reasoning that makes them defensible rather than arbitrary:
 *
 * - `teamSize: 5` — a single squad, the common shape for a migration like this.
 * - `weeklyRate: 6000` — a blended USD rate across mixed seniority, which is why
 *   it is "blended" rather than a senior contractor rate.
 * - `defaultTeamSize: 5` — identical to the default team size on purpose: the
 *   time adjustment is a no-op until someone changes the team size, which is the
 *   honest starting position (the bands are stated without a team assumption).
 * - `referenceServiceCount: 12` — a 12-service inventory is treated as the top of
 *   the "small/medium system" range, so normalization saturates rather than
 *   scaling linearly forever.
 * - `referencePhaseCount: 6` — likewise for phases.
 */
export const DEFAULT_ASSUMPTIONS: MigrationAssumptions = {
  teamSize: 5,
  weeklyRate: 6000,
  defaultTeamSize: 5,
  referenceServiceCount: 12,
  referencePhaseCount: 6,
  currency: "USD",
};

export function assumptionsFor(overrides: Partial<MigrationAssumptions> = {}): MigrationAssumptions {
  const merged = { ...DEFAULT_ASSUMPTIONS, ...overrides };

  // Guard rails rather than validation theatre: a zero or negative team size
  // would make the time adjustment divide by zero, and a negative rate would turn
  // a cost into a credit.
  return {
    ...merged,
    teamSize: merged.teamSize > 0 ? merged.teamSize : DEFAULT_ASSUMPTIONS.teamSize,
    weeklyRate: merged.weeklyRate >= 0 ? merged.weeklyRate : DEFAULT_ASSUMPTIONS.weeklyRate,
    defaultTeamSize: merged.defaultTeamSize > 0 ? merged.defaultTeamSize : DEFAULT_ASSUMPTIONS.defaultTeamSize,
    referenceServiceCount:
      merged.referenceServiceCount > 1 ? merged.referenceServiceCount : DEFAULT_ASSUMPTIONS.referenceServiceCount,
    referencePhaseCount:
      merged.referencePhaseCount > 1 ? merged.referencePhaseCount : DEFAULT_ASSUMPTIONS.referencePhaseCount,
  };
}

export type AssumptionLine = {
  label: string;
  value: string;
  /** Why this value, and what changing it would do. */
  note: string;
};

/** Renders the assumptions for the scorecard UI, so they are shown rather than inferred. */
export function describeAssumptions(assumptions: MigrationAssumptions): AssumptionLine[] {
  const lines: AssumptionLine[] = [];

  if (assumptions.targetEnvironment || assumptions.provider) {
    lines.push({
      label: "Target environment",
      value: [assumptions.targetEnvironment, assumptions.provider].filter(Boolean).join(" · "),
      note: "Recorded from the migration parameters. Shown, not used: infrastructure cost by target is not in the rubric's formula.",
    });
  }

  lines.push(
    {
      label: "Team size",
      value: `${assumptions.teamSize} engineer${assumptions.teamSize === 1 ? "" : "s"}`,
      note: "Scales total cost, and adjusts the timeline sublinearly (÷√(team ÷ reference team)).",
    },
    {
      label: "Blended weekly rate",
      value: `${assumptions.currency} ${assumptions.weeklyRate.toLocaleString("en-US")} / engineer-week`,
      note: "A blended rate across mixed seniority. Cost is person-weeks × this rate.",
    },
    {
      label: "Reference team size",
      value: `${assumptions.defaultTeamSize} engineers`,
      note: "The team size the timeline bands are calibrated against; at this size the adjustment is a no-op.",
    },
    {
      label: "Service-count reference",
      value: `${assumptions.referenceServiceCount} services`,
      note: "At or above this count the service-count effort term is saturated at its maximum.",
    },
    {
      label: "Phase-count reference",
      value: `${assumptions.referencePhaseCount} phases`,
      note: "At or above this count the phase-count effort term is saturated at its maximum.",
    },
  );

  return lines;
}

/**
 * Operational-data risk adjustment.
 *
 * The plan is specific about the shape of this: operational data adjusts Risk
 * **bidirectionally** — "real incident/error signals adjust risk up OR down from
 * the code-only baseline — deliberately bidirectional, since operational data can
 * also show a codebase is more stable in practice than its code smells suggest".
 *
 * Two rules make that adjustment safe to show next to a rubric-computed number:
 *
 * 1. **It is bounded.** Every term has its own cap and the total is clamped to
 *    ±`maxAdjustment`. Live operational data is noisier than a static finding, and
 *    a signal that could move Risk by 40 points would make the scorecard's
 *    "computed from structured findings" claim dishonest.
 * 2. **Every term is a threshold band, not a fitted coefficient.** A reader can
 *    check the arithmetic in their head, which is the same standard the rest of
 *    the rubric is held to.
 *
 * Thresholds are operational rules of thumb rather than measurements (an error
 * rate under 1% is healthy for an internal service API; unavailability below
 * 99.9% is visible to users at this scale). They are stated here so they can be
 * argued with in one place instead of being buried in a formula.
 */
export const OPERATIONAL_RISK = {
  /** Hard bound on the total adjustment, in Risk points, either direction. */
  maxAdjustment: 15,
  errorRate: {
    /** At or below this mean error rate, the term is a credit. */
    healthyPercent: 1,
    /** At or above this mean error rate, the term is at its maximum penalty. */
    criticalPercent: 10,
    /** Most Risk a healthy error rate can remove. */
    maxCredit: 6,
    /** Most Risk an unhealthy error rate can add. */
    maxPenalty: 10,
  },
  uptime: {
    /** At or above this measured availability, the term is a credit. */
    healthyPercent: 99.9,
    /** At or below this availability, the term is at its maximum penalty. */
    poorPercent: 99,
    maxCredit: 4,
    maxPenalty: 8,
  },
  incidents: {
    /** Credit for incident data that reports nothing at all, i.e. evidence of stability. */
    maxCredit: 3,
    /** Risk added per critical-severity incident, and the cap on that term. */
    perCritical: 3,
    maxCriticalPenalty: 8,
    /** Risk added per incident of any severity, and the cap. */
    perIncident: 1,
    maxIncidentPenalty: 4,
  },
  logs: {
    /** Capped separately: a log is a sample, not a measurement. */
    maxPenalty: 4,
    /** Error-line density at or above this scores the full log penalty. */
    saturatedErrorDensity: 0.1,
  },
} as const;

/** The `operational_data.kind` values, redeclared so scoring needs no DB import. */
export const OPERATIONAL_KINDS = ["log", "health", "traffic", "incident", "db_stats"] as const;
export type OperationalKind = (typeof OPERATIONAL_KINDS)[number];

/** Target environments the migration-parameter form accepts. */
export const TARGET_ENVIRONMENTS = ["cloud", "on-prem", "hybrid"] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number];

/**
 * Accepted ranges for the migration parameters, used to reject nonsense at the
 * edge rather than silently coercing it. A team size of 0 or a negative budget is
 * a typo, and a scorecard built on a typo is worse than one that says "not set".
 */
export const PARAMETER_LIMITS = {
  teamSize: { min: 1, max: 100 },
  weeklyRate: { min: 0, max: 1_000_000 },
  budget: { min: 0, max: 1_000_000_000_000 },
  timelineWeeks: { min: 1, max: 520 },
} as const;

/** Pure helpers, exported so the formulas read as formulas. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
