import { describe, expect, it } from "vitest";

import {
  DEFAULT_ASSUMPTIONS,
  RISK_LEVEL_VALUES,
  TIME_BANDS,
  assumptionsFor,
  clamp,
  describeAssumptions,
  type RiskLevel,
} from "./assumptions";
import {
  DEFAULT_RISK_WEIGHTING,
  computeRiskScore,
  computeRiskWeights,
  dependentCountsFromEdges,
} from "./weights";
import {
  assessEvidence,
  bandFor,
  computeCost,
  computeEffort,
  computeReadiness,
  computeScorecard,
  computeTime,
  normalizeCount,
  restructuringShare,
  type ScorecardInput,
  type ScoringFinding,
} from "./rubric";

/**
 * The rubric is the one piece of this project whose output is a number a reader is
 * meant to trust, so the tests are about boundaries and monotonicity rather than
 * happy paths: "the score is 62 on this fixture" is a snapshot, while "adding a
 * riskier service can never lower the aggregate" is the property that makes the
 * score meaningful.
 */

const finding = (overrides: Partial<ScoringFinding> = {}): ScoringFinding => ({
  serviceName: "service",
  riskLevel: "low",
  hasTestCoverageGap: false,
  dataQualityIssueCount: 0,
  requiresMajorRestructuring: false,
  dependentCount: 0,
  ...overrides,
});

const input = (overrides: Partial<ScorecardInput> = {}): ScorecardInput => ({
  findings: [finding({ serviceName: "a" })],
  dependencies: [],
  ...overrides,
});

describe("assumptions", () => {
  it("carries documented defaults", () => {
    expect(DEFAULT_ASSUMPTIONS.teamSize).toBeGreaterThan(0);
    expect(DEFAULT_ASSUMPTIONS.weeklyRate).toBeGreaterThan(0);
    expect(DEFAULT_ASSUMPTIONS.defaultTeamSize).toBe(DEFAULT_ASSUMPTIONS.teamSize);
    expect(DEFAULT_ASSUMPTIONS.currency).toBe("USD");
  });

  it("is overridable per field without losing the others", () => {
    const assumptions = assumptionsFor({ teamSize: 12 });
    expect(assumptions.teamSize).toBe(12);
    expect(assumptions.weeklyRate).toBe(DEFAULT_ASSUMPTIONS.weeklyRate);
  });

  it("refuses a team size that would divide by zero", () => {
    expect(assumptionsFor({ teamSize: 0 }).teamSize).toBe(DEFAULT_ASSUMPTIONS.teamSize);
    expect(assumptionsFor({ teamSize: -3 }).teamSize).toBe(DEFAULT_ASSUMPTIONS.teamSize);
  });

  it("refuses a negative rate, which would turn cost into a credit", () => {
    expect(assumptionsFor({ weeklyRate: -1 }).weeklyRate).toBe(DEFAULT_ASSUMPTIONS.weeklyRate);
  });

  it("allows a zero rate, which is a legitimate 'cost not modelled' input", () => {
    expect(assumptionsFor({ weeklyRate: 0 }).weeklyRate).toBe(0);
  });

  it("describes every assumption with a label, value and rationale", () => {
    const lines = describeAssumptions(assumptionsFor());
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line.label.length).toBeGreaterThan(0);
      expect(line.value.length).toBeGreaterThan(0);
      expect(line.note.length).toBeGreaterThan(10);
    }
  });

  it("states the documented risk mapping", () => {
    expect(RISK_LEVEL_VALUES).toEqual({ critical: 100, high: 75, medium: 50, low: 25 });
  });
});

describe("clamp", () => {
  it("bounds both ends", () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-4, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
  });

  it("treats NaN as the minimum rather than propagating it", () => {
    // Propagating NaN would produce a scorecard full of nulls at render time.
    expect(clamp(Number.NaN, 1, 10)).toBe(1);
  });
});

describe("normalizeCount", () => {
  it("maps the domain floor to 0 and the reference to 1", () => {
    expect(normalizeCount(1, 12)).toBe(0);
    expect(normalizeCount(12, 12)).toBe(1);
  });

  it("saturates above the reference instead of growing without bound", () => {
    expect(normalizeCount(500, 12)).toBe(1);
  });

  it("is monotone non-decreasing", () => {
    let previous = -1;
    for (let count = 0; count <= 20; count += 1) {
      const value = normalizeCount(count, 12);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("treats an empty count as 0", () => {
    expect(normalizeCount(0, 12)).toBe(0);
  });
});

describe("risk", () => {
  it("returns 0 for an empty inventory rather than an invented midpoint", () => {
    expect(computeRiskScore([])).toBe(0);
  });

  it("returns the single service's risk value for one service", () => {
    expect(computeRiskScore([{ serviceName: "a", riskLevel: "high", dependentCount: 0 }])).toBe(75);
  });

  it.each([
    ["critical", 100],
    ["high", 75],
    ["medium", 50],
    ["low", 25],
  ] as [RiskLevel, number][])("uses %s = %i under equal weighting", (riskLevel, expected) => {
    expect(computeRiskScore([{ serviceName: "a", riskLevel, dependentCount: 0 }])).toBe(expected);
  });

  it("averages multiple services equally in the default mode", () => {
    const score = computeRiskScore([
      { serviceName: "a", riskLevel: "critical", dependentCount: 0 },
      { serviceName: "b", riskLevel: "low", dependentCount: 0 },
    ]);
    expect(score).toBe(62.5);
  });

  it("is clamped to 0–100 for any combination of levels", () => {
    const levels: RiskLevel[] = ["critical", "high", "medium", "low"];
    for (const a of levels) {
      for (const b of levels) {
        const score = computeRiskScore([
          { serviceName: "a", riskLevel: a, dependentCount: 0 },
          { serviceName: "b", riskLevel: b, dependentCount: 0 },
        ]);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });

  it("never lets a lower-risk inventory score worse, all else equal", () => {
    // The direction property: swapping any service for a lower-risk one must not
    // raise the aggregate.
    const order: RiskLevel[] = ["critical", "high", "medium", "low"];
    for (let index = 0; index < order.length - 1; index += 1) {
      const riskier = computeRiskScore([
        { serviceName: "a", riskLevel: order[index] as RiskLevel, dependentCount: 1 },
        { serviceName: "b", riskLevel: "medium", dependentCount: 1 },
      ]);
      const safer = computeRiskScore([
        { serviceName: "a", riskLevel: order[index + 1] as RiskLevel, dependentCount: 1 },
        { serviceName: "b", riskLevel: "medium", dependentCount: 1 },
      ]);
      expect(safer).toBeLessThanOrEqual(riskier);
    }
  });

  it("defaults to equal weighting", () => {
    expect(DEFAULT_RISK_WEIGHTING).toBe("equal");
  });
});

describe("risk weighting modes", () => {
  const services = [
    { serviceName: "hub", riskLevel: "critical" as RiskLevel, dependentCount: 5 },
    { serviceName: "leaf", riskLevel: "low" as RiskLevel, dependentCount: 0 },
  ];

  it("gives every service the same share under equal weighting", () => {
    const weights = computeRiskWeights(services, "equal");
    expect(weights[0]?.share).toBe(0.5);
    expect(weights[1]?.share).toBe(0.5);
  });

  it("raises the share of a service others depend on under dependency weighting", () => {
    const weights = computeRiskWeights(services, "dependency");
    expect(weights[0]?.share).toBeGreaterThan(weights[1]?.share ?? 0);
  });

  it("weights a highly-depended-on service above equal weighting", () => {
    expect(computeRiskScore(services, "dependency")).toBeGreaterThan(
      computeRiskScore(services, "equal"),
    );
  });

  it("is identical to equal weighting when no edges are recorded", () => {
    // The property that makes dependency weighting safe to ship: an empty graph
    // degrades to the documented v1 formula, not to something else.
    const noEdges = [
      { serviceName: "a", riskLevel: "critical" as RiskLevel, dependentCount: 0 },
      { serviceName: "b", riskLevel: "low" as RiskLevel, dependentCount: 0 },
    ];
    expect(computeRiskScore(noEdges, "dependency")).toBe(computeRiskScore(noEdges, "equal"));
  });

  it("never gives a service zero weight, even as a leaf", () => {
    const weights = computeRiskWeights(services, "dependency");
    expect(weights.every((weight) => weight.share > 0)).toBe(true);
  });

  it("normalizes shares to exactly 1", () => {
    const weights = computeRiskWeights(services, "dependency");
    expect(weights.reduce((sum, weight) => sum + weight.share, 0)).toBeCloseTo(1, 10);
  });

  it("returns no weights for an empty inventory", () => {
    expect(computeRiskWeights([], "dependency")).toEqual([]);
  });

  it("derives dependent counts from edges", () => {
    const counts = dependentCountsFromEdges([
      { fromService: "order-service", toService: "payment-service" },
      { fromService: "customer-service", toService: "payment-service" },
      { fromService: "order-service", toService: "payment-service" },
    ]);
    expect(counts.get("paymentservice")).toBe(2);
  });

  it("ignores self-edges when deriving counts", () => {
    expect(dependentCountsFromEdges([{ fromService: "a", toService: "a" }]).size).toBe(0);
  });
});

describe("effort", () => {
  it("stays within 1–10 for an empty inventory", () => {
    const { effort } = computeEffort({ findings: [], phaseCount: 0, riskScore: 0 });
    expect(effort).toBeGreaterThanOrEqual(1);
    expect(effort).toBeLessThanOrEqual(10);
  });

  it("sits near the floor for the smallest possible system", () => {
    // One service, one phase, lowest risk, no restructuring — the documented
    // minimum shape, not a degenerate input.
    const { effort } = computeEffort({
      findings: [finding({ riskLevel: "low" })],
      phaseCount: 1,
      riskScore: 25,
    });
    expect(effort).toBeLessThan(2);
    expect(effort).toBeGreaterThanOrEqual(1);
  });

  it("reaches the ceiling for the largest documented shape", () => {
    const findings = Array.from({ length: 12 }, (_, index) =>
      finding({
        serviceName: `s${index}`,
        riskLevel: "critical",
        requiresMajorRestructuring: true,
      }),
    );
    const { effort } = computeEffort({ findings, phaseCount: 6, riskScore: 100 });
    expect(effort).toBe(10);
  });

  it("is clamped to 1–10 even for absurd input", () => {
    const findings = Array.from({ length: 500 }, (_, index) =>
      finding({ serviceName: `s${index}`, riskLevel: "critical", requiresMajorRestructuring: true }),
    );
    const { effort } = computeEffort({ findings, phaseCount: 500, riskScore: 100 });
    expect(effort).toBe(10);
  });

  it("does not decrease as the service count grows, risk held equal", () => {
    // Risk is held constant deliberately: adding a low-risk service to a
    // high-risk inventory lowers the aggregate risk, and the risk term is *meant*
    // to respond to that. This isolates the service-count term.
    let previous = 0;
    for (let count = 1; count <= 15; count += 1) {
      const findings = Array.from({ length: count }, (_, index) =>
        finding({ serviceName: `s${index}`, riskLevel: "medium" }),
      );
      const { effort } = computeEffort({ findings, phaseCount: 3, riskScore: 50 });
      expect(effort).toBeGreaterThanOrEqual(previous);
      previous = effort;
    }
  });

  it("does not decrease as the phase count grows", () => {
    let previous = 0;
    for (let phases = 1; phases <= 8; phases += 1) {
      const { effort } = computeEffort({
        findings: [finding({ serviceName: "a", riskLevel: "medium" })],
        phaseCount: phases,
        riskScore: 50,
      });
      expect(effort).toBeGreaterThanOrEqual(previous);
      previous = effort;
    }
  });

  it("increases effort when a service requires major restructuring", () => {
    const baseline = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "medium" })],
      phaseCount: 2,
      riskScore: 50,
    });
    const restructuring = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "medium", requiresMajorRestructuring: true })],
      phaseCount: 2,
      riskScore: 50,
    });
    expect(restructuring.effort).toBeGreaterThan(baseline.effort);
  });

  it("leaves effort unchanged when restructuring does not change", () => {
    const a = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "medium" }), finding({ serviceName: "b" })],
      phaseCount: 2,
      riskScore: 50,
    });
    const b = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "medium" }), finding({ serviceName: "b" })],
      phaseCount: 2,
      riskScore: 50,
    });
    expect(a.effort).toBe(b.effort);
  });

  it("increases effort as risk rises", () => {
    const low = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "low" })],
      phaseCount: 1,
      riskScore: 25,
    });
    const high = computeEffort({
      findings: [finding({ serviceName: "a", riskLevel: "critical" })],
      phaseCount: 1,
      riskScore: 100,
    });
    expect(high.effort).toBeGreaterThan(low.effort);
  });

  it("reports the normalized terms it used", () => {
    const breakdown = computeEffort({
      findings: [finding({ serviceName: "a" }), finding({ serviceName: "b" })],
      phaseCount: 3,
      riskScore: 50,
    });
    expect(breakdown.normalized.risk).toBe(0.5);
    expect(breakdown.terms.serviceCount).toBeCloseTo(0.3 / 11, 6);
    expect(breakdown.raw).toBeGreaterThan(0);
  });
});

describe("time", () => {
  it("applies the documented band for each effort value", () => {
    expect(bandFor(1).label).toBe("4–8 weeks");
    expect(bandFor(2).label).toBe("8–16 weeks");
    expect(bandFor(3).label).toBe("8–16 weeks");
    expect(bandFor(4).label).toBe("3–6 months");
    expect(bandFor(5).label).toBe("3–6 months");
    expect(bandFor(6).label).toBe("6–9 months");
    expect(bandFor(7).label).toBe("6–9 months");
    expect(bandFor(8).label).toBe("9–12+ months");
    expect(bandFor(9).label).toBe("9–12+ months");
    expect(bandFor(10).label).toBe("9–12+ months");
  });

  it("covers every effort value with no gap", () => {
    for (let effort = 1; effort <= 10; effort += 0.1) {
      expect(bandFor(effort)).toBeDefined();
    }
  });

  it("stays inside each band's documented range", () => {
    // Sampled just inside each band rather than at its endpoints: the bands share
    // endpoints by design (so they tile 1–10), and a shared endpoint resolves to
    // the higher band.
    for (const [index, band] of TIME_BANDS.entries()) {
      const sample = index === TIME_BANDS.length - 1 ? 10 : band.minEffort + 0.01;
      const estimate = computeTime(sample);

      expect(estimate.band).toBe(band);
      expect(estimate.weeksMax).toBeLessThanOrEqual(band.maxWeeks);
      expect(estimate.weeksMin).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps every estimate inside the documented overall span", () => {
    for (let effort = 1; effort <= 10; effort += 0.1) {
      const estimate = computeTime(effort);
      expect(estimate.weeksMin).toBeGreaterThanOrEqual(4);
      expect(estimate.weeksMax).toBeLessThanOrEqual(52);
      expect(estimate.weeksMin).toBeLessThanOrEqual(estimate.weeksMax);
    }
  });

  it("never reports a shorter timeline for a higher effort", () => {
    // The plan's band table overlaps (effort 3–4 reaches 16 weeks while effort
    // 5–6 starts at 13), so both ends of the range must be non-decreasing rather
    // than assumed to be.
    let previousMin = 0;
    let previousMax = 0;

    for (let effort = 1; effort <= 10; effort += 0.25) {
      const estimate = computeTime(effort);
      expect(estimate.weeksMin).toBeGreaterThanOrEqual(previousMin - 0.01);
      expect(estimate.weeksMax).toBeGreaterThanOrEqual(previousMax - 0.01);
      previousMin = Math.max(previousMin, estimate.weeksMin);
      previousMax = Math.max(previousMax, estimate.weeksMax);
    }
  });

  it("is a pure derivation from effort", () => {
    expect(computeTime(5)).toEqual(computeTime(5));
  });

  it("is unadjusted when the team matches the reference", () => {
    expect(computeTime(5).teamFactor).toBe(1);
  });

  it("shortens the timeline for a larger team, sublinearly", () => {
    const baseline = computeTime(5);
    const bigger = computeTime(5, { teamSize: 20, defaultTeamSize: 5 });
    expect(bigger.weeksMax).toBeLessThan(baseline.weeksMax);
    // Sublinear: four times the team must not mean a quarter of the time.
    expect(bigger.weeksMax).toBeGreaterThan(baseline.weeksMax / 4);
  });

  it("lengthens the timeline for a smaller team", () => {
    const baseline = computeTime(5);
    const smaller = computeTime(5, { teamSize: 2, defaultTeamSize: 5 });
    expect(smaller.weeksMax).toBeGreaterThan(baseline.weeksMax);
  });
});

describe("cost", () => {
  it("is duration × team size × rate", () => {
    const cost = computeCost({ durationWeeks: 16, teamSize: 5, weeklyRate: 6000 });
    expect(cost.personWeeks).toBe(80);
    expect(cost.cost).toBe(480_000);
  });

  it("is zero when the rate is zero", () => {
    expect(computeCost({ durationWeeks: 16, teamSize: 5, weeklyRate: 0 }).cost).toBe(0);
  });

  it("is zero when the duration is zero", () => {
    expect(computeCost({ durationWeeks: 0, teamSize: 5, weeklyRate: 6000 }).cost).toBe(0);
  });

  it("scales linearly with the weekly rate", () => {
    const base = computeCost({ durationWeeks: 10, teamSize: 4, weeklyRate: 5000 });
    const doubled = computeCost({ durationWeeks: 10, teamSize: 4, weeklyRate: 10_000 });
    expect(doubled.cost).toBe(base.cost * 2);
  });

  it("scales linearly with person-weeks", () => {
    const base = computeCost({ durationWeeks: 10, teamSize: 4, weeklyRate: 5000 });
    const doubled = computeCost({ durationWeeks: 20, teamSize: 4, weeklyRate: 5000 });
    expect(doubled.cost).toBe(base.cost * 2);
  });

  it("scales linearly with team size at a fixed duration", () => {
    const base = computeCost({ durationWeeks: 10, teamSize: 4, weeklyRate: 5000 });
    const doubled = computeCost({ durationWeeks: 10, teamSize: 8, weeklyRate: 5000 });
    expect(doubled.cost).toBe(base.cost * 2);
  });
});

describe("readiness", () => {
  const readiness = (overrides: Partial<Parameters<typeof computeReadiness>[0]> = {}) =>
    computeReadiness({
      findings: [finding({ serviceName: "a" })],
      riskScore: 25,
      effort: 2,
      ...overrides,
    });

  it("stays within 0–100 for an empty inventory", () => {
    const empty = computeReadiness({ findings: [], riskScore: 0, effort: 1 });
    expect(empty.readiness).toBeGreaterThanOrEqual(0);
    expect(empty.readiness).toBeLessThanOrEqual(100);
  });

  it("reaches 100 for a sound, low-risk, unencumbered system", () => {
    const best = readiness({
      architecture: { currentArchitectureLargelySound: true, phasedPlan: [] },
      riskScore: 0,
      effort: 1,
    });
    expect(best.readiness).toBe(100);
  });

  it("falls for a high-risk system", () => {
    expect(readiness({ riskScore: 100 }).readiness).toBeLessThan(readiness({ riskScore: 25 }).readiness);
  });

  it("falls when services need major restructuring", () => {
    const restructured = readiness({
      findings: [finding({ serviceName: "a", requiresMajorRestructuring: true })],
    });
    expect(restructured.readiness).toBeLessThan(readiness().readiness);
  });

  it("falls when test coverage is missing", () => {
    const uncovered = readiness({ findings: [finding({ serviceName: "a", hasTestCoverageGap: true })] });
    expect(uncovered.readiness).toBeLessThan(readiness().readiness);
  });

  it("falls as data-quality issues accumulate, saturating", () => {
    const none = readiness().readiness;
    const some = readiness({ findings: [finding({ serviceName: "a", dataQualityIssueCount: 2 })] }).readiness;
    const many = readiness({ findings: [finding({ serviceName: "a", dataQualityIssueCount: 50 })] }).readiness;

    expect(some).toBeLessThan(none);
    expect(many).toBeLessThan(some);
    // Saturation: past four issues per service the penalty stops growing.
    const beyond = readiness({ findings: [finding({ serviceName: "a", dataQualityIssueCount: 500 })] }).readiness;
    expect(beyond).toBe(many);
  });

  it("rises when the architecture is stated to be largely sound", () => {
    const withSignal = readiness({
      architecture: { currentArchitectureLargelySound: true, phasedPlan: [] },
    });
    const without = readiness();
    expect(withSignal.readiness).toBeGreaterThan(without.readiness);
  });

  it("falls as effort rises", () => {
    expect(readiness({ effort: 9 }).readiness).toBeLessThan(readiness({ effort: 2 }).readiness);
  });

  it("is monotone non-increasing as risk rises, all else equal", () => {
    let previous = 101;
    for (const riskScore of [0, 25, 50, 75, 100]) {
      const value = readiness({ riskScore }).readiness;
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("is never negative even under every penalty at once", () => {
    const worst = readiness({
      findings: [
        finding({
          serviceName: "a",
          riskLevel: "critical",
          hasTestCoverageGap: true,
          dataQualityIssueCount: 99,
          requiresMajorRestructuring: true,
        }),
      ],
      architecture: { currentArchitectureLargelySound: false, phasedPlan: [] },
      riskScore: 100,
      effort: 10,
    });
    expect(worst.readiness).toBeGreaterThanOrEqual(0);
  });
});

describe("share helpers", () => {
  it("computes the restructuring share", () => {
    expect(
      restructuringShare([
        finding({ serviceName: "a", requiresMajorRestructuring: true }),
        finding({ serviceName: "b", requiresMajorRestructuring: false }),
      ]),
    ).toBe(0.5);
  });

  it("returns 0 for an empty inventory", () => {
    expect(restructuringShare([])).toBe(0);
    expect(restructuringShare([])).toBe(0);
  });
});

describe("computeScorecard", () => {
  it("produces all five scores", () => {
    const scorecard = computeScorecard(
      input({
        findings: [finding({ serviceName: "a", riskLevel: "high", dataQualityIssueCount: 1 })],
        architecture: { currentArchitectureLargelySound: false, phasedPlan: [{ phaseNumber: 1 }] },
      }),
    );

    expect(scorecard.risk).toBe(75);
    expect(scorecard.effort).toBeGreaterThanOrEqual(1);
    expect(scorecard.cost).toBeGreaterThan(0);
    expect(scorecard.time.weeksMax).toBeGreaterThan(0);
    expect(scorecard.readiness).toBeGreaterThan(0);
  });

  it("is deterministic: the same input gives the same scores", () => {
    const fixture = input({
      findings: [
        finding({ serviceName: "a", riskLevel: "high", dependentCount: 2 }),
        finding({ serviceName: "b", riskLevel: "low", dataQualityIssueCount: 3 }),
      ],
      dependencies: [{ fromService: "a", toService: "b", type: "sync_call" }],
      architecture: { currentArchitectureLargelySound: true, phasedPlan: [{ phaseNumber: 1 }] },
    });

    const first = computeScorecard(fixture);
    const second = computeScorecard(fixture);
    const third = computeScorecard(JSON.parse(JSON.stringify(fixture)));

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("handles an empty inventory without throwing or emitting NaN", () => {
    const scorecard = computeScorecard({ findings: [], dependencies: [] });
    expect(scorecard.risk).toBe(0);
    expect(scorecard.effort).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(scorecard.cost)).toBe(true);
    expect(Number.isFinite(scorecard.readiness)).toBe(true);
    expect(scorecard.counts.services).toBe(0);
  });

  it("records which risk weighting produced the score", () => {
    const equal = computeScorecard(input({ riskWeighting: "equal" }));
    const dependency = computeScorecard(input({ riskWeighting: "dependency" }));
    expect(equal.riskWeighting).toBe("equal");
    expect(dependency.riskWeighting).toBe("dependency");
  });

  it("changes cost when the weekly rate assumption changes", () => {
    const cheap = computeScorecard(input({ assumptions: { weeklyRate: 1000 } }));
    const dear = computeScorecard(input({ assumptions: { weeklyRate: 9000 } }));
    expect(dear.cost).toBeGreaterThan(cheap.cost);
  });

  it("changes cost when the team-size assumption changes", () => {
    const small = computeScorecard(input({ assumptions: { teamSize: 3 } }));
    const large = computeScorecard(input({ assumptions: { teamSize: 15 } }));
    expect(large.cost).toBeGreaterThan(small.cost);
  });

  it("reports the assumption set it used", () => {
    const scorecard = computeScorecard(input({ assumptions: { teamSize: 9 } }));
    expect(scorecard.assumptions.teamSize).toBe(9);
    expect(scorecard.assumptions.weeklyRate).toBe(DEFAULT_ASSUMPTIONS.weeklyRate);
  });

  it("carries the code-only confidence label", () => {
    expect(computeScorecard(input()).confidence.codeOnly).toBe(true);
    expect(computeScorecard(input()).confidence.label).toBe("code-only estimate");
  });

  it("counts what it consumed", () => {
    const scorecard = computeScorecard({
      findings: [finding({ serviceName: "a" }), finding({ serviceName: "b" })],
      dependencies: [{ fromService: "a", toService: "b", type: "shared_db" }],
      architecture: { currentArchitectureLargelySound: true, phasedPlan: [{ phaseNumber: 1 }, { phaseNumber: 2 }] },
    });
    expect(scorecard.counts).toEqual({ services: 2, dependencies: 1, phases: 2 });
  });
});

describe("evidence quality", () => {
  const complete = input({
    findings: [finding({ serviceName: "a" }), finding({ serviceName: "b" })],
    dependencies: [{ fromService: "a", toService: "b", type: "sync_call" }],
    architecture: { currentArchitectureLargelySound: true, phasedPlan: [{ phaseNumber: 1 }] },
    risk: {
      ranked: [
        { serviceName: "a", riskLevel: "low" },
        { serviceName: "b", riskLevel: "high" },
      ],
      operationalDataAvailable: false,
    },
  });

  it("is strong when findings, edges, architecture and a full risk ranking are present", () => {
    const evidence = assessEvidence(complete);
    expect(evidence.level).toBe("strong");
    expect(evidence.reasons.length).toBeGreaterThan(0);
  });

  it("is limited when there are no findings at all", () => {
    expect(assessEvidence({ findings: [], dependencies: [] }).level).toBe("limited");
  });

  it("is partial when no dependency edges were recorded", () => {
    const evidence = assessEvidence({ ...complete, dependencies: [] });
    expect(evidence.level).toBe("partial");
    expect(evidence.reasons.join(" ")).toContain("dependency");
  });

  it("is partial when the architecture output is missing", () => {
    const evidence = assessEvidence({ ...complete, architecture: undefined });
    expect(evidence.level).toBe("partial");
    expect(evidence.reasons.join(" ")).toContain("architecture");
  });

  it("is partial when the risk ranking does not cover every service", () => {
    const evidence = assessEvidence({
      ...complete,
      risk: { ranked: [{ serviceName: "a", riskLevel: "low" }], operationalDataAvailable: false },
    });
    expect(evidence.level).toBe("partial");
    expect(evidence.reasons.join(" ")).toContain("not rated");
  });

  it("matches service names across naming conventions when checking coverage", () => {
    const evidence = assessEvidence({
      ...complete,
      findings: [finding({ serviceName: "order-service" }), finding({ serviceName: "payment-service" })],
      risk: {
        ranked: [
          { serviceName: "orderService", riskLevel: "low" },
          { serviceName: "PaymentService", riskLevel: "high" },
        ],
        operationalDataAvailable: false,
      },
    });
    expect(evidence.level).toBe("strong");
  });

  it("is partial when the comparison stage flagged missed items", () => {
    const evidence = assessEvidence({
      ...complete,
      comparison: { matched: ["a"], missed: ["the dead-letter queue"], incorrect: [] },
    });
    expect(evidence.level).toBe("partial");
    expect(evidence.reasons.join(" ")).toContain("missed");
  });
});
