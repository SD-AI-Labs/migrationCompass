import { describe, expect, it } from "vitest";

import { OPERATIONAL_RISK } from "./assumptions";
import { recomputeScorecard } from "./refine";
import type { ScorecardInput } from "./rubric";
import {
  sampleFixtureDependencies,
  sampleFixtureFindings,
  sampleOperationalEntries,
  sampleOperationalFileNames,
  sampleOperationalFiles,
} from "@/lib/testing/sample-fixture";

/**
 * The two checked-in operational datasets, through the real recalculation.
 *
 * This is the browser-demonstrable half of M5: `fixtures/sample-legacy-api.operational/
 * healthy/` and `.../degraded/` are the exact files a user attaches to the scorecard,
 * and the assertions below are the claims the UI makes about them — healthy data
 * lowers Risk, degraded data raises it, and both stay inside the documented bound.
 *
 * Testing the files rather than literals matters: a dataset that only exists inside a
 * test proves nothing about the upload path.
 */

const input = (): ScorecardInput => ({
  findings: sampleFixtureFindings(),
  dependencies: sampleFixtureDependencies(),
  architecture: {
    currentArchitectureLargelySound: false,
    phasedPlan: [{ phaseNumber: 1 }, { phaseNumber: 2 }, { phaseNumber: 3 }],
  },
  risk: {
    ranked: sampleFixtureFindings().map((finding) => ({
      serviceName: finding.serviceName,
      riskLevel: finding.riskLevel,
    })),
    operationalDataAvailable: false,
  },
  comparison: { matched: ["a"], missed: [], incorrect: [] },
});

describe("the checked-in operational data fixtures", () => {
  it("each contain a health, incident and log file, and every one parses", () => {
    for (const scenario of ["healthy", "degraded"] as const) {
      expect(sampleOperationalFileNames(scenario)).toEqual(["app.log", "health.json", "incidents.json"]);

      const parsed = sampleOperationalEntries(scenario);
      expect(parsed.errors).toEqual([]);
      expect(parsed.entries.map((entry) => entry.kind).sort()).toEqual(["health", "incident", "log"]);
    }
  });

  it("describe a healthy system, and lower Risk", () => {
    const parsed = sampleOperationalEntries("healthy");
    const refined = recomputeScorecard({ input: input(), entries: parsed.entries });

    expect(refined.adjustment.delta).toBeLessThan(0);
    expect(refined.scorecard.risk).toBeLessThan(refined.baseline.risk);
    expect(refined.scorecard.confidence.label).toBe("refined with operational data");
    // Measured evidence, not a claim: the reason text names the measured numbers.
    expect(refined.adjustment.reasons.join(" ")).toMatch(/Measured error rate/);
    expect(refined.adjustment.reasons.join(" ")).toMatch(/Clean incident history/);
  });

  it("describe a degraded system, and raise Risk", () => {
    const parsed = sampleOperationalEntries("degraded");
    const refined = recomputeScorecard({ input: input(), entries: parsed.entries });

    expect(refined.adjustment.delta).toBeGreaterThan(0);
    expect(refined.scorecard.risk).toBeGreaterThan(refined.baseline.risk);
    const reasons = refined.adjustment.reasons.join(" ");
    expect(reasons).toMatch(/Measured error rate/);
    expect(reasons).toMatch(/Measured availability/);
    expect(reasons).toMatch(/Critical incidents/);
    expect(reasons).toMatch(/Error density in logs/);
  });

  it("stay inside the bounded adjustment, whichever scenario is supplied", () => {
    for (const scenario of ["healthy", "degraded"] as const) {
      const refined = recomputeScorecard({ input: input(), entries: sampleOperationalEntries(scenario).entries });
      expect(Math.abs(refined.adjustment.delta)).toBeLessThanOrEqual(OPERATIONAL_RISK.maxAdjustment);
      expect(refined.scorecard.risk).toBeGreaterThanOrEqual(0);
      expect(refined.scorecard.risk).toBeLessThanOrEqual(100);
    }
  });

  it("are read the same way whether they arrive as files or as stored entries", () => {
    // The upload path parses files; the scorecard path reads rows. Both must produce
    // the same signals, or a scorecard would differ depending on when the data arrived.
    const files = sampleOperationalFiles("degraded");
    const parsed = sampleOperationalEntries("degraded");

    expect(files).toHaveLength(3);
    expect(parsed.entries).toHaveLength(3);

    const fromFiles = recomputeScorecard({ input: input(), entries: parsed.entries });
    const again = recomputeScorecard({ input: input(), entries: parsed.entries });
    expect(again.scorecard).toEqual(fromFiles.scorecard);
  });
});
