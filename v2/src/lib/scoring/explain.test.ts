import { describe, expect, it } from "vitest";

import type { ScoringFinding } from "./rubric";
import {
  CONTRIBUTION_TOLERANCE,
  SCORE_LABELS,
  SCORE_NAMES,
  contributionsSum,
  explainScorecard,
  verifyContributions,
} from "./explain";

/**
 * The explanation is the answer to "why is this 62?", which is the plan's whole
 * argument for a rubric over a model-generated number. So the tests check that it
 * is *arithmetic over the same inputs* — contributions that sum, signed penalties,
 * the assumptions in force — and not a paragraph of plausible text.
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

const input = () => ({
  findings: [
    finding({ serviceName: "order-service", riskLevel: "high" as const, dependentCount: 2 }),
    finding({
      serviceName: "payment-service",
      riskLevel: "critical" as const,
      hasTestCoverageGap: true,
      dataQualityIssueCount: 3,
      requiresMajorRestructuring: true,
    }),
    finding({ serviceName: "customer-service", riskLevel: "low" as const }),
  ],
  dependencies: [
    { fromService: "customer-service", toService: "order-service", type: "sync_call" },
    { fromService: "order-service", toService: "payment-service", type: "sync_call" },
  ],
  architecture: { currentArchitectureLargelySound: false, phasedPlan: [{ phaseNumber: 1 }, { phaseNumber: 2 }] },
  risk: {
    ranked: [
      { serviceName: "order-service", riskLevel: "high" as const },
      { serviceName: "payment-service", riskLevel: "critical" as const },
      { serviceName: "customer-service", riskLevel: "low" as const },
    ],
    operationalDataAvailable: false,
  },
  comparison: { matched: ["customer risk"], missed: [], incorrect: [] },
});

describe("explainScorecard", () => {
  it("explains all five scores", () => {
    const explanation = explainScorecard(input());
    expect(Object.keys(explanation.scores).sort()).toEqual([...SCORE_NAMES].sort());
  });

  it("labels each score with its product name", () => {
    const explanation = explainScorecard(input());
    for (const name of SCORE_NAMES) {
      expect(explanation.scores[name].label).toBe(SCORE_LABELS[name]);
    }
  });

  it("carries the confidence vocabulary through to the UI layer", () => {
    const explanation = explainScorecard(input());
    expect(explanation.confidenceLabel).toBe("code-only estimate");
    expect(explanation.evidence.level).toBe("strong");
  });

  it("names the assumptions and weighting in force", () => {
    const explanation = explainScorecard({ ...input(), riskWeighting: "dependency" as const });
    expect(explanation.assumptions.teamSize).toBeGreaterThan(0);
    expect(explanation.riskWeighting).toBe("dependency");
  });

  it("is serializable, so a server component can hand it to a client one", () => {
    const explanation = explainScorecard(input());
    expect(JSON.parse(JSON.stringify(explanation))).toEqual(explanation);
  });
});

describe("additive contributions", () => {
  it.each(["risk", "effort", "readiness"] as const)(
    "%s contributions sum to the score within tolerance",
    (name) => {
      const explanation = explainScorecard(input());
      const score = explanation.scores[name];

      expect(score.additive).toBe(true);
      expect(verifyContributions(score)).toBe(true);
      expect(Math.abs(contributionsSum(score) - score.value)).toBeLessThanOrEqual(CONTRIBUTION_TOLERANCE);
    },
  );

  it("holds across a spread of inputs, not just one fixture", () => {
    const variants = [
      { findings: [], dependencies: [] },
      { findings: [finding({ serviceName: "only" })], dependencies: [] },
      {
        findings: [
          finding({ serviceName: "a", riskLevel: "critical" as const, requiresMajorRestructuring: true }),
        ],
        dependencies: [],
      },
      input(),
    ];

    for (const variant of variants) {
      const explanation = explainScorecard(variant);
      for (const name of ["risk", "effort", "readiness"] as const) {
        expect(verifyContributions(explanation.scores[name])).toBe(true);
      }
    }
  });
});

describe("risk explanation", () => {
  it("has one contribution per service, summing to the aggregate", () => {
    const risk = explainScorecard(input()).scores.risk;
    expect(risk.contributions).toHaveLength(3);
    expect(risk.contributions.map((contribution) => contribution.label).sort()).toEqual([
      "customer-service",
      "order-service",
      "payment-service",
    ]);
  });

  it("shows the risk value and the weight behind each contribution", () => {
    const risk = explainScorecard(input()).scores.risk;
    const payment = risk.contributions.find((contribution) => contribution.key === "payment-service");
    expect(payment?.detail).toContain("100/100");
    expect(payment?.detail).toContain("%");
  });

  it("explains dependency weighting when it is in force", () => {
    const risk = explainScorecard({ ...input(), riskWeighting: "dependency" }).scores.risk;
    expect(risk.factors.map((factor) => factor.value).join(" ")).toContain("Dependency-weighted");
    expect(risk.contributions.some((contribution) => contribution.detail.includes("dependent"))).toBe(true);
  });

  it("says plainly when there is nothing to aggregate", () => {
    const risk = explainScorecard({ findings: [], dependencies: [] }).scores.risk;
    expect(risk.value).toBe(0);
    expect(risk.summary).toContain("No services");
  });
});

describe("effort explanation", () => {
  it("is decomposed into the documented weighted terms plus the floor", () => {
    const effort = explainScorecard(input()).scores.effort;
    const keys = effort.contributions.map((contribution) => contribution.key).sort();
    expect(keys).toEqual(["base", "phaseCount", "restructuring", "risk", "serviceCount"]);
  });

  it("names the documented weights in the details", () => {
    const effort = explainScorecard(input()).scores.effort;
    const serviceCount = effort.contributions.find((contribution) => contribution.key === "serviceCount");
    const phaseCount = effort.contributions.find((contribution) => contribution.key === "phaseCount");
    expect(serviceCount?.detail).toContain("0.3");
    expect(phaseCount?.detail).toContain("0.2");
  });

  it("exposes the raw normalized terms for debugging", () => {
    const effort = explainScorecard(input()).scores.effort;
    expect(effort.inputs.services).toBe(3);
    expect(effort.inputs.phases).toBe(2);
    expect(Number(effort.inputs.raw)).toBeGreaterThan(0);
  });
});

describe("readiness explanation", () => {
  it("shows credits as positive and penalties as negative", () => {
    const readiness = explainScorecard(input()).scores.readiness;
    const value = (key: string) =>
      readiness.contributions.find((contribution) => contribution.key === key)?.value ?? 0;

    expect(value("base")).toBeGreaterThan(0);
    expect(value("effortPenalty")).toBeLessThanOrEqual(0);
    expect(value("restructuringPenalty")).toBeLessThanOrEqual(0);
    expect(value("testCoveragePenalty")).toBeLessThanOrEqual(0);
    expect(value("dataQualityPenalty")).toBeLessThanOrEqual(0);
  });

  it("explains the architecture term either way", () => {
    const without = explainScorecard(input()).scores.readiness;
    const withSignal = explainScorecard({
      ...input(),
      architecture: { currentArchitectureLargelySound: true, phasedPlan: [] },
    }).scores.readiness;

    expect(without.contributions.find((c) => c.key === "architectureSound")?.value).toBe(0);
    expect(withSignal.contributions.find((c) => c.key === "architectureSound")?.value).toBeGreaterThan(0);
  });

  it("states that no architecture output was persisted when that is the case", () => {
    const readiness = explainScorecard({ ...input(), architecture: undefined }).scores.readiness;
    const architecture = readiness.contributions.find((c) => c.key === "architectureSound");
    expect(architecture?.detail).toContain("No architecture output");
  });

  it("shows the penalty reasoning in structured terms, not prose", () => {
    const readiness = explainScorecard(input()).scores.readiness;
    const dataQuality = readiness.contributions.find((c) => c.key === "dataQualityPenalty");
    // Counts and saturation limits, so a reader can recompute the number.
    expect(dataQuality?.detail).toMatch(/issues per service/);
    expect(dataQuality?.detail).toContain("4");
  });
});

describe("non-additive scores", () => {
  it("marks cost as multiplicative and exposes factors instead", () => {
    const cost = explainScorecard(input()).scores.cost;
    expect(cost.additive).toBe(false);
    expect(cost.contributions).toEqual([]);
    expect(cost.factors.map((factor) => factor.label)).toEqual(
      expect.arrayContaining(["Duration", "Team size", "Blended weekly rate", "Person-weeks"]),
    );
  });

  it("explains cost as duration × team × rate with the actual numbers", () => {
    const cost = explainScorecard(input()).scores.cost;
    expect(cost.summary).toContain("person-weeks");
    expect(cost.inputs.personWeeks).toBeGreaterThan(0);
    expect(cost.inputs.weeklyRate).toBeGreaterThan(0);
  });

  it("marks time as a derivation from effort, naming the band", () => {
    const time = explainScorecard(input()).scores.time;
    expect(time.additive).toBe(false);
    expect(time.contributions).toEqual([]);
    expect(time.factors.map((factor) => factor.label)).toContain("Band applied");
    expect(time.formula).toContain("band(effort)");
  });

  it("does not pretend a multiplicative score has a sum to verify", () => {
    const explanation = explainScorecard(input());
    expect(verifyContributions(explanation.scores.cost)).toBe(true);
    expect(verifyContributions(explanation.scores.time)).toBe(true);
  });
});

describe("assumption exposure", () => {
  it("reports the assumptions actually used, not the defaults", () => {
    const explanation = explainScorecard({
      ...input(),
      assumptions: { teamSize: 12, weeklyRate: 1234 },
    });
    expect(explanation.assumptions.teamSize).toBe(12);
    expect(explanation.scores.cost.inputs.teamSize).toBe(12);
    expect(explanation.scores.cost.inputs.weeklyRate).toBe(1234);
  });

  it("reflects an assumption change in the cost explanation", () => {
    const base = explainScorecard(input()).scores.cost;
    const changed = explainScorecard({ ...input(), assumptions: { weeklyRate: 12_000 } }).scores.cost;
    expect(changed.value).toBeGreaterThan(base.value);
    expect(String(changed.formatted)).toContain("USD");
  });
});

describe("verifyContributions", () => {
  it("rejects a broken decomposition", () => {
    const risk = explainScorecard(input()).scores.risk;
    const corrupted = { ...risk, contributions: [...risk.contributions, { key: "x", label: "x", value: 50, detail: "" }] };
    expect(verifyContributions(corrupted)).toBe(false);
  });

  it("honours an explicit tolerance", () => {
    const risk = explainScorecard(input()).scores.risk;
    // Contributions are rounded for display, so a sum is exact only to rounding
    // drift — which is exactly what the documented tolerance is for.
    expect(verifyContributions(risk, CONTRIBUTION_TOLERANCE)).toBe(true);
    expect(verifyContributions(risk, -1)).toBe(false);
  });
});
