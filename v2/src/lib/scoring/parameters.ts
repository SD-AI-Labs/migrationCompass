import {
  PARAMETER_LIMITS,
  TARGET_ENVIRONMENTS,
  assumptionsFor,
  type MigrationAssumptions,
  type TargetEnvironment,
} from "./assumptions";
import type { Scorecard } from "./rubric";

/**
 * Migration parameters: the business assumptions a user supplies.
 *
 * Distinct from operational data on purpose, and the plan is explicit that the two
 * must not be conflated: operational data is *objective facts about the running
 * system* (and therefore moves Risk), while migration parameters are *business
 * assumptions, not files* — team size, budget, timeline, target environment — and
 * therefore parameterise the cost/time conversion rather than the risk judgement.
 *
 * So this module does two things and no third:
 *
 * 1. **Validates** submitted values, returning per-field messages rather than a
 *    single "invalid input". Every rejection is actionable by construction
 *    ("Team size must be between 1 and 100") because a number born from a typo
 *    silently becomes a cost estimate nobody can justify.
 * 2. **Maps them onto the existing assumptions**, so the rubric's formula is
 *    unchanged and no constant is restated in the UI. Team size and the blended
 *    rate are the two parameters the formula actually consumes; budget, timeline
 *    and environment are assessments *about* the result, not inputs to it, and
 *    saying so is the honest reading.
 */

export type MigrationParametersInput = {
  targetEnvironment: TargetEnvironment | null;
  provider: string | null;
  teamSize: number | null;
  weeklyRate: number | null;
  budget: number | null;
  timelineWeeks: number | null;
};

export const EMPTY_PARAMETERS: MigrationParametersInput = {
  targetEnvironment: null,
  provider: null,
  teamSize: null,
  weeklyRate: null,
  budget: null,
  timelineWeeks: null,
};

export type ParameterValidation = {
  ok: boolean;
  /** Field name → message a person can act on. Empty when valid. */
  errors: Record<string, string>;
  values: MigrationParametersInput;
};

/** Raw form values, already unwrapped from FormData. */
export type RawParameterInput = Partial<Record<keyof MigrationParametersInput, unknown>>;

function readNumber(
  field: keyof typeof PARAMETER_LIMITS,
  raw: unknown,
  errors: Record<string, string>,
): number | null {
  if (raw === undefined || raw === null) return null;

  const text = typeof raw === "string" ? raw.trim() : raw;
  if (text === "" ) return null;

  const value = typeof text === "number" ? text : Number(text);
  if (!Number.isFinite(value)) {
    errors[field] = `${labelFor(field)} must be a number.`;
    return null;
  }

  const { min, max } = PARAMETER_LIMITS[field];
  if (value < min || value > max) {
    errors[field] = `${labelFor(field)} must be between ${min} and ${max}.`;
    return null;
  }

  return field === "teamSize" || field === "timelineWeeks" ? Math.round(value) : value;
}

function labelFor(field: keyof typeof PARAMETER_LIMITS): string {
  switch (field) {
    case "teamSize":
      return "Team size";
    case "weeklyRate":
      return "Blended weekly rate";
    case "budget":
      return "Budget";
    case "timelineWeeks":
      return "Timeline (weeks)";
    default:
      return field;
  }
}

function readText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates a parameter submission.
 *
 * Blank fields are not errors — every parameter is optional, and an untouched form
 * means "keep the defaults", not "you must fill this in".
 */
export function validateParameters(raw: RawParameterInput): ParameterValidation {
  const errors: Record<string, string> = {};

  const environmentText = readText(raw.targetEnvironment);
  let targetEnvironment: TargetEnvironment | null = null;
  if (environmentText !== null) {
    const match = TARGET_ENVIRONMENTS.find((candidate) => candidate === environmentText.toLowerCase());
    if (match === undefined) {
      errors.targetEnvironment = `Target environment must be one of: ${TARGET_ENVIRONMENTS.join(", ")}.`;
    } else {
      targetEnvironment = match;
    }
  }

  const values: MigrationParametersInput = {
    targetEnvironment,
    provider: readText(raw.provider),
    teamSize: readNumber("teamSize", raw.teamSize, errors),
    weeklyRate: readNumber("weeklyRate", raw.weeklyRate, errors),
    budget: readNumber("budget", raw.budget, errors),
    timelineWeeks: readNumber("timelineWeeks", raw.timelineWeeks, errors),
  };

  return { ok: Object.keys(errors).length === 0, errors, values };
}

/**
 * The parameters the rubric's formulas consume.
 *
 * Only team size and the blended rate appear here. Passing `undefined` for an
 * untouched parameter is deliberate: `assumptionsFor` then keeps the documented
 * default, so a partially filled form refines what it can and leaves the rest
 * exactly as the code-only estimate had it.
 */
export function assumptionsFromParameters(
  parameters: MigrationParametersInput,
  base?: Partial<MigrationAssumptions>,
): Partial<MigrationAssumptions> {
  const overrides: Partial<MigrationAssumptions> = { ...base };

  if (parameters.teamSize !== null) overrides.teamSize = parameters.teamSize;
  if (parameters.weeklyRate !== null) overrides.weeklyRate = parameters.weeklyRate;
  if (parameters.provider !== null) {
    // Informational: the plan flags an infrastructure cost delta for a cloud target
    // as a later addition, so the provider is carried into the assumptions to be
    // shown, never into the cost arithmetic.
    overrides.provider = parameters.provider;
  }
  if (parameters.targetEnvironment !== null) {
    overrides.targetEnvironment = parameters.targetEnvironment;
  }

  return overrides;
}

/** True when the user has actually set something worth showing. */
export function hasAnyParameter(parameters: MigrationParametersInput): boolean {
  return (
    parameters.targetEnvironment !== null ||
    parameters.provider !== null ||
    parameters.teamSize !== null ||
    parameters.weeklyRate !== null ||
    parameters.budget !== null ||
    parameters.timelineWeeks !== null
  );
}

export type ParameterAssessmentStatus = "within" | "over" | "under" | "noted" | "unset";

export type ParameterAssessment = {
  key: string;
  label: string;
  value: string;
  status: ParameterAssessmentStatus;
  note: string;
};

/**
 * Compares the supplied parameters against the computed estimate.
 *
 * These are comparisons, not calculations: the score is already computed, and a
 * budget that the estimate exceeds must be reported as a conflict between a plan
 * and a constraint rather than folded into the number. Folding it in would let a
 * small budget produce a small cost, which is precisely the dishonesty the
 * rubric exists to avoid.
 */
export function assessParameters(
  parameters: MigrationParametersInput,
  scorecard: Scorecard,
): ParameterAssessment[] {
  const assessments: ParameterAssessment[] = [];
  const currency = scorecard.assumptions.currency;

  if (parameters.targetEnvironment !== null) {
    assessments.push({
      key: "targetEnvironment",
      label: "Target environment",
      value:
        parameters.provider !== null
          ? `${parameters.targetEnvironment} (${parameters.provider})`
          : parameters.targetEnvironment,
      status: "noted",
      note: "Recorded for the plan. An infrastructure cost delta by target is not part of the rubric's cost formula.",
    });
  }

  if (parameters.teamSize !== null) {
    assessments.push({
      key: "teamSize",
      label: "Team size",
      value: `${parameters.teamSize} engineer${parameters.teamSize === 1 ? "" : "s"}`,
      status: "noted",
      note:
        `In force: the cost figure uses this team size, and the timeline is adjusted ÷√(team ÷ ` +
        `${scorecard.assumptions.defaultTeamSize} reference team).`,
    });
  }

  if (parameters.weeklyRate !== null) {
    assessments.push({
      key: "weeklyRate",
      label: "Blended weekly rate",
      value: `${currency} ${parameters.weeklyRate.toLocaleString("en-US")}`,
      status: "noted",
      note: "In force: cost is total person-weeks × this rate.",
    });
  }

  if (parameters.budget !== null) {
    const over = scorecard.cost - parameters.budget;
    assessments.push({
      key: "budget",
      label: "Budget",
      value: `${currency} ${Math.round(parameters.budget).toLocaleString("en-US")}`,
      status: over > 0 ? "over" : "within",
      note:
        over > 0
          ? `The estimate exceeds the budget by ${currency} ${Math.round(over).toLocaleString("en-US")}. The budget is a constraint, not an input — it does not lower the estimate.`
          : `The estimate is within the budget by ${currency} ${Math.round(-over).toLocaleString("en-US")}.`,
    });
  }

  if (parameters.timelineWeeks !== null) {
    const over = scorecard.time.weeksMid - parameters.timelineWeeks;
    assessments.push({
      key: "timelineWeeks",
      label: "Timeline",
      value: `${parameters.timelineWeeks} week(s)`,
      status: over > 0 ? "over" : "within",
      note:
        over > 0
          ? `The representative estimate (${scorecard.time.weeksMid} weeks) runs ${over.toFixed(1)} weeks past the stated timeline.`
          : `The representative estimate (${scorecard.time.weeksMid} weeks) fits inside the stated timeline.`,
    });
  }

  return assessments;
}

/** The assumptions in force for a refined scorecard, defaults included. */
export function refinedAssumptions(
  parameters: MigrationParametersInput,
  base?: Partial<MigrationAssumptions>,
): MigrationAssumptions {
  return assumptionsFor(assumptionsFromParameters(parameters, base));
}
