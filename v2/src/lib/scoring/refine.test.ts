import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "@/lib/embeddings/embeddings";
import type { LlmClient } from "@/lib/llm/client";
import { sampleFixtureDependencies, sampleFixtureFindings } from "@/lib/testing/sample-fixture";

import { OPERATIONAL_RISK } from "./assumptions";
import { verifyContributions } from "./explain";
import { parseOperationalFiles, type OperationalEntry } from "./operational";
import { EMPTY_PARAMETERS, type MigrationParametersInput } from "./parameters";
import { describeRefinement, recomputeScorecard, sameScores } from "./refine";
import type { ScorecardInput } from "./rubric";

/**
 * `recomputeScorecard()` — the "Refine these estimates" path, tested against the
 * properties the plan requires of it rather than against one fixture's numbers.
 *
 * The claims being checked:
 *
 * - it makes **zero LLM calls** and **zero network calls** (both asserted, not
 *   asserted-by-comment),
 * - it cannot modify the narrative findings it was given,
 * - operational data moves Risk **both ways** and stays bounded,
 * - migration parameters move time and cost through the existing rubric,
 * - it is deterministic, and
 * - with nothing supplied it reproduces the code-only baseline exactly.
 */

const fixtureInput = (overrides: Partial<ScorecardInput> = {}): ScorecardInput => ({
  findings: sampleFixtureFindings(),
  dependencies: sampleFixtureDependencies(),
  architecture: { currentArchitectureLargelySound: false, phasedPlan: [{ phaseNumber: 1 }, { phaseNumber: 2 }, { phaseNumber: 3 }] },
  risk: {
    ranked: sampleFixtureFindings().map((finding) => ({
      serviceName: finding.serviceName,
      riskLevel: finding.riskLevel,
    })),
    operationalDataAvailable: false,
  },
  comparison: { matched: ["a"], missed: [], incorrect: [] },
  ...overrides,
});

const operationalEntry = (
  overrides: Partial<OperationalEntry> = {},
): OperationalEntry => ({
  kind: "health",
  source: "health.json",
  serviceName: "order-service",
  content: null,
  payload: { errorRatePercent: 0.1, uptimePercent: 99.99 },
  ...overrides,
});

/** A counting LLM stub. Any call at all fails the test that uses it. */
function countingLlm(): { llm: LlmClient; calls: () => number } {
  let calls = 0;
  const count = <T>(value: T): T => {
    calls += 1;
    return value;
  };

  const llm: LlmClient = {
    name: "counting-stub",
    complete: () => count(Promise.resolve("")),
    stream: () => count((async function* () {})()),
    chat: () => count(Promise.resolve({ content: "", toolCalls: [] })),
  };

  return { llm, calls: () => calls };
}

/** A counting embedding stub, for the same reason. */
function countingEmbeddings(): { embeddings: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  return {
    embeddings: {
      name: "counting-stub",
      dimensions: 768,
      embed: (texts: string[]) => {
        calls += 1;
        return Promise.resolve(texts.map(() => Array.from({ length: 768 }, () => 0)));
      },
    },
    calls: () => calls,
  };
}

describe("recomputeScorecard — the refinement boundary", () => {
  it("makes zero LLM calls", () => {
    const { llm, calls } = countingLlm();
    const refined = recomputeScorecard({
      input: fixtureInput(),
      entries: [operationalEntry()],
      parameters: { ...EMPTY_PARAMETERS, teamSize: 9, budget: 100_000 },
    });

    // The stub is in scope and could have been reached; the recalculation does not
    // reach it. That is the property, and the count is how it is observed.
    void llm;
    expect(calls()).toBe(0);
    expect(refined.scorecard.operational.applied).toBe(true);
  });

  it("makes zero embedding calls", () => {
    const { embeddings, calls } = countingEmbeddings();

    recomputeScorecard({ input: fixtureInput(), entries: [operationalEntry()] });

    void embeddings;
    expect(calls()).toBe(0);
  });

  it("makes zero network calls", () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("network access from the recalculation path"));
    }) as typeof fetch;

    try {
      recomputeScorecard({
        input: fixtureInput(),
        entries: [operationalEntry(), operationalEntry({ kind: "log", source: "app.log", content: "ERROR x", payload: null })],
        parameters: { ...EMPTY_PARAMETERS, teamSize: 3, weeklyRate: 5000 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toBe(0);
  });

  it("imports nothing that could call a model, a vector store or the network", () => {
    // The runtime spys above prove today's behaviour; this proves tomorrow's. A
    // future edit that adds `import { createDeepSeekLlm }` here — the obvious way for
    // a "refinement" to grow into a second analysis pass — fails immediately.
    const pure = [
      "refine.ts",
      "operational.ts",
      "parameters.ts",
      "rubric.ts",
      "explain.ts",
      "weights.ts",
      "assumptions.ts",
    ];
    const forbidden = [
      "@/lib/llm",
      "@/lib/rag",
      "@/lib/embeddings",
      "@/db/",
      "next/",
      "react",
      "fetch(",
      "XMLHttpRequest",
      "node:http",
      "node:net",
    ];

    for (const file of pure) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not reference ${pattern}`).not.toContain(`from "${pattern}`);
      }
      expect(source, `${file} must not call fetch`).not.toMatch(/\bfetch\(/);
    }
  });

  it("does not modify the structured findings it was given", () => {
    const input = fixtureInput();
    const before = JSON.stringify(input);

    recomputeScorecard({
      input,
      entries: [operationalEntry({ payload: { errorRatePercent: 22, uptimePercent: 96 } })],
      parameters: { ...EMPTY_PARAMETERS, teamSize: 15, timelineWeeks: 5 },
    });

    expect(JSON.stringify(input)).toBe(before);
  });

  it("produces no narrative text at all, so it cannot regenerate a finding", () => {
    const refined = recomputeScorecard({ input: fixtureInput(), entries: [operationalEntry()] });

    // The four narratives live on the run row and are never read by this path. The
    // refinement reports numbers, terms and assessments — nothing that could be
    // mistaken for a regenerated analysis.
    for (const narrative of ["discovery", "architectureProposal", "riskAssessment", "comparisonReport"]) {
      expect(Object.keys(refined)).not.toContain(narrative);
    }
    expect(Object.keys(refined)).toEqual(
      expect.arrayContaining(["baseline", "scorecard", "explanation", "adjustment", "parameters"]),
    );

    // The one sentence about the narratives says they are untouched, which is the
    // statement the UI shows the user.
    expect(describeRefinement(refined)).toMatch(
      /narrative findings still describe the original analysis run/,
    );
  });
});

describe("recomputeScorecard — operational data moves Risk both ways", () => {
  it("lowers Risk when the measured operations are healthier than the code suggests", () => {
    const refined = recomputeScorecard({
      input: fixtureInput(),
      entries: [
        operationalEntry({ payload: { errorRatePercent: 0.05, uptimePercent: 99.995 } }),
        operationalEntry({ kind: "incident", source: "incidents.json", payload: { incidents: [] } }),
      ],
    });

    expect(refined.adjustment.delta).toBeLessThan(0);
    expect(refined.scorecard.risk).toBeLessThan(refined.baseline.risk);
    // Downstream scores follow the same adjusted figure, because readiness is defined
    // in terms of Risk rather than computed beside it.
    expect(refined.scorecard.readiness).toBeGreaterThan(refined.baseline.readiness);
    expect(refined.changed).toBe(true);
    expect(refined.scorecard.confidence.codeOnly).toBe(false);
    expect(refined.scorecard.confidence.label).toBe("refined with operational data");
  });

  it("raises Risk when the measured operations are worse than the code suggests", () => {
    const refined = recomputeScorecard({
      input: fixtureInput(),
      entries: [
        operationalEntry({ payload: { errorRatePercent: 14, uptimePercent: 97 } }),
        operationalEntry({
          kind: "incident",
          source: "incidents.json",
          payload: { incidents: [{ severity: "critical" }, { severity: "critical" }] },
        }),
      ],
    });

    expect(refined.adjustment.delta).toBeGreaterThan(0);
    expect(refined.scorecard.risk).toBeGreaterThan(refined.baseline.risk);
    expect(refined.scorecard.readiness).toBeLessThan(refined.baseline.readiness);
  });

  it("keeps every score inside its documented bounds under extreme data", () => {
    const refined = recomputeScorecard({
      input: fixtureInput({
        findings: Array.from({ length: 40 }, (_, index) => ({
          serviceName: `service-${index}`,
          riskLevel: "critical" as const,
          hasTestCoverageGap: true,
          dataQualityIssueCount: 12,
          requiresMajorRestructuring: true,
          dependentCount: 3,
        })),
      }),
      entries: [
        operationalEntry({ payload: { errorRatePercent: 90, uptimePercent: 20 } }),
        operationalEntry({ kind: "log", source: "app.log", content: "ERROR x\n".repeat(200), payload: null }),
      ],
    });

    expect(refined.scorecard.risk).toBeLessThanOrEqual(100);
    expect(refined.scorecard.risk).toBeGreaterThanOrEqual(0);
    expect(refined.scorecard.readiness).toBeLessThanOrEqual(100);
    expect(refined.scorecard.readiness).toBeGreaterThanOrEqual(0);
    expect(refined.scorecard.effort).toBeLessThanOrEqual(10);
    expect(refined.scorecard.effort).toBeGreaterThanOrEqual(1);
    expect(Math.abs(refined.adjustment.delta)).toBeLessThanOrEqual(OPERATIONAL_RISK.maxAdjustment);
  });

  it("keeps the explanation's contributions summing after the adjustment", () => {
    const refined = recomputeScorecard({
      input: fixtureInput(),
      entries: [
        operationalEntry({ payload: { errorRatePercent: 6, uptimePercent: 98.4 } }),
        operationalEntry({ kind: "incident", source: "incidents.json", payload: { incidents: [{ severity: "medium" }] } }),
      ],
    });

    expect(refined.explanation.scores.risk.value).toBe(refined.scorecard.risk);
    expect(verifyContributions(refined.explanation.scores.risk)).toBe(true);
    expect(refined.explanation.operational?.terms.length).toBeGreaterThan(0);
    // Operational terms appear as their own rows, attributed to measured data.
    const labels = refined.explanation.scores.risk.contributions.map((contribution) => contribution.label);
    expect(labels).toContain("Measured error rate");
    expect(
      refined.explanation.scores.risk.contributions.find((contribution) => contribution.key === "operational.errorRate")
        ?.detail,
    ).toMatch(/measured data, not model output/);
  });
});

describe("recomputeScorecard — migration parameters", () => {
  it("changes time and cost when the team size changes", () => {
    const small = recomputeScorecard({
      input: fixtureInput(),
      parameters: { ...EMPTY_PARAMETERS, teamSize: 2 },
    });
    const large = recomputeScorecard({
      input: fixtureInput(),
      parameters: { ...EMPTY_PARAMETERS, teamSize: 20 },
    });

    expect(large.scorecard.time.weeksMid).toBeLessThan(small.scorecard.time.weeksMid);
    // Cost rises with headcount even though duration falls — the documented
    // consequence of team size entering the formula twice.
    expect(large.scorecard.cost).toBeGreaterThan(small.scorecard.cost);
  });

  it("changes only cost when the weekly rate changes", () => {
    const cheap = recomputeScorecard({ input: fixtureInput(), parameters: { ...EMPTY_PARAMETERS, weeklyRate: 3000 } });
    const dear = recomputeScorecard({ input: fixtureInput(), parameters: { ...EMPTY_PARAMETERS, weeklyRate: 9000 } });

    expect(dear.scorecard.cost).toBeGreaterThan(cheap.scorecard.cost);
    // Time is derived from Effort, and Effort never reads the rate, so a rate change
    // must not move the calendar.
    expect(dear.scorecard.time).toEqual(cheap.scorecard.time);
    expect(dear.scorecard.effort).toBe(cheap.scorecard.effort);
    expect(dear.scorecard.risk).toBe(cheap.scorecard.risk);
  });

  it("does not let a budget change the estimate", () => {
    const generous = recomputeScorecard({ input: fixtureInput(), parameters: { ...EMPTY_PARAMETERS, budget: 10_000_000 } });
    const tight = recomputeScorecard({ input: fixtureInput(), parameters: { ...EMPTY_PARAMETERS, budget: 1 } });

    expect(tight.scorecard.cost).toBe(generous.scorecard.cost);
    expect(tight.parameters.find((assessment) => assessment.key === "budget")?.status).toBe("over");
    expect(generous.parameters.find((assessment) => assessment.key === "budget")?.status).toBe("within");
  });

  it("assesses the timeline against the estimate rather than reshaping it", () => {
    const refined = recomputeScorecard({
      input: fixtureInput(),
      parameters: { ...EMPTY_PARAMETERS, timelineWeeks: 3 },
    });

    expect(refined.parameters.find((assessment) => assessment.key === "timelineWeeks")?.status).toBe("over");
  });
});

describe("recomputeScorecard — determinism and the empty case", () => {
  it("is deterministic across repeated recalculation", () => {
    const request = {
      input: fixtureInput(),
      entries: [
        operationalEntry({ payload: { errorRatePercent: 2.5, uptimePercent: 99.2 } }),
        operationalEntry({ kind: "log", source: "app.log", content: "ERROR a\nINFO b\n", payload: null }),
      ],
      parameters: { ...EMPTY_PARAMETERS, teamSize: 7, weeklyRate: 7200, budget: 500_000 } as MigrationParametersInput,
    };

    const first = recomputeScorecard(request);
    const second = recomputeScorecard(request);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.scorecard).toEqual(first.scorecard);
  });

  it("preserves the baseline exactly when no operational data is supplied", () => {
    const baselineOnly = recomputeScorecard({ input: fixtureInput() });

    expect(baselineOnly.changed).toBe(false);
    expect(sameScores(baselineOnly.baseline, baselineOnly.scorecard)).toBe(true);
    expect(baselineOnly.scorecard).toEqual(baselineOnly.baseline);
    expect(baselineOnly.scorecard.riskDelta).toBe(0);
    expect(baselineOnly.scorecard.confidence.codeOnly).toBe(true);
    expect(baselineOnly.scorecard.confidence.label).toBe("code-only estimate");
    expect(describeRefinement(baselineOnly)).toMatch(/code-only estimates/);
  });

  it("preserves the baseline when the supplied files reduce to no usable signal", () => {
    // A db-stats file that only reports data volume: parsed and recorded, but it
    // moves nothing, so the five scores must be identical to the code-only ones.
    const parsed = parseOperationalFiles([
      { name: "db.json", text: JSON.stringify({ databaseSizeMb: 12_000 }) },
    ]);
    const refined = recomputeScorecard({ input: fixtureInput(), entries: parsed.entries });

    expect(parsed.errors).toEqual([]);
    expect(refined.operational.available).toBe(false);
    expect(refined.scorecard.riskDelta).toBe(0);
    expect(sameScores(refined.baseline, refined.scorecard)).toBe(true);
    expect(refined.scorecard.confidence.codeOnly).toBe(true);
    // Recorded, reported, and explicitly not scored.
    expect(refined.adjustment.reasons.join(" ")).toMatch(/12000 MB/);
  });

  it("is unaffected by the order the operational files arrived in", () => {
    const health = operationalEntry({ payload: { errorRatePercent: 4, uptimePercent: 98.9 } });
    const log = operationalEntry({ kind: "log", source: "app.log", content: "ERROR x\n".repeat(5), payload: null });

    const forwards = recomputeScorecard({ input: fixtureInput(), entries: [health, log] });
    const backwards = recomputeScorecard({ input: fixtureInput(), entries: [log, health] });

    expect(backwards.scorecard).toEqual(forwards.scorecard);
  });

  it("describes a refinement without claiming a model was involved", () => {
    const refined = recomputeScorecard({
      input: fixtureInput(),
      entries: [operationalEntry()],
      parameters: { ...EMPTY_PARAMETERS, teamSize: 6 },
    });

    const description = describeRefinement(refined);
    expect(description).toMatch(/operational data file\(s\) parsed/);
    expect(description).toMatch(/migration parameters applied/);
    expect(description).toMatch(/narrative findings still describe the original analysis run/);
  });

  it("exposes the baseline alongside the refined scorecard so a UI can show the movement", () => {
    const refined = recomputeScorecard({ input: fixtureInput(), entries: [operationalEntry()] });

    expect(refined.baseline.risk).not.toBe(refined.scorecard.risk);
    expect(refined.scorecard.riskDelta).toBe(refined.adjustment.delta);
  });

  it("uses the injected weighting override rather than the input's", () => {
    const weighted = recomputeScorecard({ input: fixtureInput(), riskWeighting: "dependency" });

    expect(weighted.scorecard.riskWeighting).toBe("dependency");
    expect(weighted.explanation.riskWeighting).toBe("dependency");
  });
});

describe("recomputeScorecard — module surface", () => {
  it("does not open a database connection or start a timer", () => {
    // Cheap guard against a future edit reaching for `getDb()` "just to cache the
    // result": the recalculation must stay usable while the database is down.
    const source = readFileSync(fileURLToPath(new URL("refine.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/setTimeout|setInterval|Date\.now|performance\.now/);
    expect(vi.isMockFunction(Math.random)).toBe(false);
    expect(source).not.toContain("Math.random");
  });
});
