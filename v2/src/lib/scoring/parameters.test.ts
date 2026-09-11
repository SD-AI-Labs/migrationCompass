import { describe, expect, it } from "vitest";

import { OPERATIONAL_KINDS, TARGET_ENVIRONMENTS, assumptionsFor } from "./assumptions";
import {
  EMPTY_PARAMETERS,
  assessParameters,
  assumptionsFromParameters,
  hasAnyParameter,
  validateParameters,
} from "./parameters";

/**
 * Migration parameters are *business assumptions*, and the plan is explicit that
 * they are not conflated with operational data: they parameterise the cost and time
 * conversion, they do not touch Risk. The tests below hold that line — a budget is
 * compared against the estimate, never folded into it.
 */

describe("parameter validation", () => {
  it("treats blank fields as unset rather than invalid", () => {
    const result = validateParameters({
      targetEnvironment: "",
      provider: "  ",
      teamSize: "",
      weeklyRate: "",
      budget: "",
      timelineWeeks: "",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.values).toEqual(EMPTY_PARAMETERS);
  });

  it("accepts the documented ranges and trims text", () => {
    const result = validateParameters({
      targetEnvironment: "cloud",
      provider: "  AWS eu-west-1  ",
      teamSize: "12",
      weeklyRate: "7500",
      budget: "900000",
      timelineWeeks: "40",
    });

    expect(result.ok).toBe(true);
    expect(result.values.targetEnvironment).toBe("cloud");
    expect(result.values.provider).toBe("AWS eu-west-1");
    expect(result.values.teamSize).toBe(12);
    expect(result.values.weeklyRate).toBe(7500);
  });

  it("rejects a team size outside the accepted range with a message naming it", () => {
    const result = validateParameters({ teamSize: "0" });

    expect(result.ok).toBe(false);
    expect(result.errors.teamSize).toMatch(/Team size must be between 1 and 100/);
    // The invalid value is not silently coerced into a valid one: a team size born
    // from a typo would otherwise become a cost estimate nobody can justify.
    expect(result.values.teamSize).toBeNull();
  });

  it("rejects a non-numeric value", () => {
    const result = validateParameters({ budget: "about a million" });

    expect(result.ok).toBe(false);
    expect(result.errors.budget).toMatch(/must be a number/);
  });

  it("rejects an unknown target environment and lists the accepted ones", () => {
    const result = validateParameters({ targetEnvironment: "mainframe" });

    expect(result.ok).toBe(false);
    expect(result.errors.targetEnvironment).toContain(TARGET_ENVIRONMENTS.join(", "));
  });

  it("accepts a target environment case-insensitively", () => {
    const result = validateParameters({ targetEnvironment: "CLOUD" });

    expect(result.ok).toBe(true);
    expect(result.values.targetEnvironment).toBe("cloud");
  });

  it("reports every bad field at once rather than one per submission", () => {
    const result = validateParameters({ teamSize: "-3", weeklyRate: "nope", timelineWeeks: "9000" });

    expect(Object.keys(result.errors).sort()).toEqual(["teamSize", "timelineWeeks", "weeklyRate"]);
  });

  it("knows the difference between an untouched form and a filled one", () => {
    expect(hasAnyParameter(EMPTY_PARAMETERS)).toBe(false);
    expect(hasAnyParameter({ ...EMPTY_PARAMETERS, teamSize: 8 })).toBe(true);
    // The informational fields count too: a target environment nobody set is not the
    // same scorecard as one that says "on-prem".
    expect(hasAnyParameter({ ...EMPTY_PARAMETERS, targetEnvironment: "on-prem" })).toBe(true);
  });
});

describe("parameters → assumptions", () => {
  it("maps only the two inputs the formula consumes, and keeps the rest", () => {
    const partial = assumptionsFromParameters({ ...EMPTY_PARAMETERS, teamSize: 12, weeklyRate: 7500 });
    const assumptions = assumptionsFor(partial);

    expect(assumptions.teamSize).toBe(12);
    expect(assumptions.weeklyRate).toBe(7500);
    // The scaling references are untouched: a team-size change must not quietly move
    // the normalization the effort formula depends on.
    expect(assumptions.referenceServiceCount).toBe(assumptionsFor().referenceServiceCount);
    expect(assumptions.defaultTeamSize).toBe(assumptionsFor().defaultTeamSize);
  });

  it("leaves the defaults in force for parameters the user did not set", () => {
    const assumptions = assumptionsFor(assumptionsFromParameters(EMPTY_PARAMETERS));

    expect(assumptions.teamSize).toBe(assumptionsFor().teamSize);
    expect(assumptions.weeklyRate).toBe(assumptionsFor().weeklyRate);
  });

  it("carries the target environment as a recorded value, not an input", () => {
    const assumptions = assumptionsFor(
      assumptionsFromParameters({ ...EMPTY_PARAMETERS, targetEnvironment: "cloud", provider: "GCP" }),
    );

    expect(assumptions.targetEnvironment).toBe("cloud");
    expect(assumptions.provider).toBe("GCP");
    // Nothing in the cost or time formulas reads these, which is why the scorecard
    // labels them "recorded, not used".
    expect(assumptions.teamSize).toBe(assumptionsFor().teamSize);
    expect(assumptions.weeklyRate).toBe(assumptionsFor().weeklyRate);
  });

  it("exposes the operational kinds the ingestion path accepts", () => {
    // Guards the redeclaration in the scoring layer against drifting from the schema.
    expect(OPERATIONAL_KINDS).toContain("log");
    expect(OPERATIONAL_KINDS).toContain("db_stats");
  });
});

describe("parameter assessment", () => {
  const scorecard = {
    cost: 500_000,
    time: { weeksMin: 20, weeksMax: 30, weeksMid: 25 },
    assumptions: { currency: "USD", defaultTeamSize: 5, teamSize: 5, weeklyRate: 6000 },
  } as unknown as Parameters<typeof assessParameters>[1];

  it("says a budget is exceeded rather than lowering the estimate to fit it", () => {
    const [budget] = assessParameters({ ...EMPTY_PARAMETERS, budget: 400_000 }, scorecard);

    expect(budget?.status).toBe("over");
    expect(budget?.note).toMatch(/exceeds the budget by USD 100,000/);
    expect(budget?.note).toMatch(/does not lower the estimate/);
  });

  it("reports a budget the estimate fits inside", () => {
    const [budget] = assessParameters({ ...EMPTY_PARAMETERS, budget: 900_000 }, scorecard);

    expect(budget?.status).toBe("within");
    expect(budget?.note).toMatch(/within the budget by USD 400,000/);
  });

  it("compares the timeline against the representative estimate", () => {
    const [over] = assessParameters({ ...EMPTY_PARAMETERS, timelineWeeks: 12 }, scorecard);
    const [within] = assessParameters({ ...EMPTY_PARAMETERS, timelineWeeks: 40 }, scorecard);

    expect(over?.status).toBe("over");
    expect(over?.note).toMatch(/13\.0 weeks past the stated timeline/);
    expect(within?.status).toBe("within");
  });

  it("assesses nothing when nothing was supplied", () => {
    expect(assessParameters(EMPTY_PARAMETERS, scorecard)).toEqual([]);
  });
});
