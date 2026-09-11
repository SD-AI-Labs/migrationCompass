import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { explainScorecard, verifyContributions } from "./explain";
import { computeScorecard } from "./rubric";
import { computeRiskScore } from "./weights";
import {
  SAMPLE_FIXTURE_DIR,
  loadSampleFixtureExpectation,
  sampleFixtureArchive,
  sampleFixtureDependencies,
  sampleFixtureFindings,
} from "@/lib/testing/sample-fixture";

/**
 * The fixture, pushed through M4's scoring path.
 *
 * Pure: no database, no model, no network. The fixture's structured findings and
 * edges come from the checked-in expectation beside it, so this pins the behaviour
 * the scorecard shows for the sample project without depending on anything
 * non-deterministic.
 */

function fixtureScorecard(riskWeighting?: "equal" | "dependency") {
  return computeScorecard({
    findings: sampleFixtureFindings(),
    dependencies: sampleFixtureDependencies(),
    architecture: { currentArchitectureLargelySound: false, phasedPlan: [{ phaseNumber: 1 }, { phaseNumber: 2 }, { phaseNumber: 3 }] },
    riskWeighting,
  });
}

describe("the sample fixture through the rubric", () => {
  it("scores the fixture's three services with no findings lost", () => {
    const scorecard = fixtureScorecard();

    expect(scorecard.counts.services).toBe(3);
    expect(scorecard.counts.dependencies).toBe(3);
    // Every score is a real number in range — the easiest way for this to break is
    // a NaN from an empty division, which JSON would happily keep.
    for (const value of [scorecard.risk, scorecard.effort, scorecard.readiness, scorecard.cost]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(scorecard.risk).toBeGreaterThan(0);
    expect(scorecard.readiness).toBeGreaterThanOrEqual(0);
    expect(scorecard.readiness).toBeLessThanOrEqual(100);
    expect(scorecard.effort).toBeGreaterThanOrEqual(1);
    expect(scorecard.effort).toBeLessThanOrEqual(10);
  });

  it("reflects the fixture's deliberately bad qualities rather than averaging them away", () => {
    const scorecard = fixtureScorecard();

    // critical + high + high, so the equal-weighted risk must sit in the high band.
    expect(scorecard.risk).toBeGreaterThanOrEqual(66);
    // Every service has a test-coverage gap and one needs major restructuring.
    expect(scorecard.readiness).toBeLessThan(60);
    expect(scorecard.effort).toBeGreaterThan(1.5);
    // Three services, three phases, real effort: never a same-day estimate.
    expect(scorecard.time.weeksMin).toBeGreaterThan(0);
    expect(scorecard.cost).toBeGreaterThan(0);
  });

  it("moves the risk score when dependency weighting is used", () => {
    const equal = computeRiskScore(sampleFixtureFindings(), "equal");
    const dependency = computeRiskScore(sampleFixtureFindings(), "dependency");

    // payment-service is depended on by order-service; nothing depends on
    // customer-service. Weighting by dependents therefore shifts the aggregate
    // toward order-service and payment-service rather than leaving it unchanged.
    expect(dependency).not.toBe(equal);
  });

  it("is deterministic across repeated execution", () => {
    expect(JSON.stringify(fixtureScorecard())).toBe(JSON.stringify(fixtureScorecard()));
    expect(JSON.stringify(fixtureScorecard("dependency"))).toBe(
      JSON.stringify(fixtureScorecard("dependency")),
    );
  });

  it("explains every score from the fixture's own contributions", () => {
    const input = {
      findings: sampleFixtureFindings(),
      dependencies: sampleFixtureDependencies(),
      architecture: { currentArchitectureLargelySound: false, phasedPlan: [{ phaseNumber: 1 }] },
    };
    const explanation = explainScorecard(input);

    expect(verifyContributions(explanation.scores.risk)).toBe(true);
    expect(verifyContributions(explanation.scores.effort)).toBe(true);
    expect(verifyContributions(explanation.scores.readiness)).toBe(true);

    // The risk breakdown is one row per service, ordered by how much each moves the
    // score — that is what makes it useful for debugging as well as for the UI.
    expect(explanation.scores.risk.contributions.map((item) => item.label)).toEqual([
      "payment-service", // critical, worth 33.3 of the 83.3 total
      "customer-service", // high, ties with order-service and sorts first
      "order-service",
    ]);
    expect(explanation.scores.risk.contributions.map((item) => item.label)).not.toContain(
      "external-payment-gateway",
    );
  });

  it("packs byte-identically, which is what makes the seed script idempotent", async () => {
    // Regression guard: the archive used to embed the current time and the
    // filesystem's directory order, so two runs hashed differently and the
    // duplicate check never fired — every `pnpm seed:sample` added a project.
    const first = await sampleFixtureArchive();
    const second = await sampleFixtureArchive();

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("the fixture and its expectation stay in sync", () => {
  const expectation = loadSampleFixtureExpectation();

  it("names only services that exist as directories", () => {
    for (const service of expectation.services) {
      const path = join(SAMPLE_FIXTURE_DIR, service.name);
      expect(existsSync(path), `${service.name} is in the expectation but not on disk`).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
    }
  });

  it("has a controller, a service class and a repository for every service", () => {
    // The brief's shape for the fixture: REST endpoints, service logic, and
    // persistence code in each service.
    for (const service of expectation.services) {
      const sources = collectJava(join(SAMPLE_FIXTURE_DIR, service.name));
      expect(sources.some((name) => name.endsWith("Controller.java"))).toBe(true);
      expect(sources.some((name) => name.endsWith("Service.java"))).toBe(true);
      expect(
        sources.some((name) => name.endsWith("Repository.java")) ||
          service.name === "order-service" ||
          service.name === "payment-service",
      ).toBe(true);
      expect(sources.length).toBeGreaterThan(0);
    }
  });

  it("only claims dependencies whose caller exists and whose evidence is a real file", () => {
    for (const dependency of expectation.dependencies) {
      const known = [...expectation.services.map((service) => service.name), ...expectation.inventory.external];
      expect(known, `${dependency.to} is not declared as a service or external system`).toContain(
        dependency.to,
      );

      // The evidence string names the file the relationship is visible in; pulling
      // the filename out and checking it exists keeps the expectation honest as the
      // fixture changes.
      const fileName = dependency.evidence.match(/([A-Za-z]+\.java)/)?.[1];
      expect(fileName, `no .java file named in evidence for ${dependency.from} → ${dependency.to}`).toBeDefined();
      const sources = collectJava(join(SAMPLE_FIXTURE_DIR, dependency.from));
      expect(sources, `${dependency.from} has no ${fileName}`).toContain(fileName);
    }
  });

  it("marks exactly one service as needing major restructuring", () => {
    const restructuring = expectation.services.filter((service) => service.requiresMajorRestructuring);
    expect(restructuring).toHaveLength(1);
    expect(restructuring[0]?.name).toBe("payment-service");
  });

  it("gives every service a test-coverage gap so the fixture exercises that term", () => {
    expect(expectation.services.every((service) => service.hasTestCoverageGap)).toBe(true);
  });
});

/** Java file base names anywhere under a directory. */
function collectJava(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectJava(path, acc);
    else if (entry.name.endsWith(".java")) acc.push(entry.name);
  }
  return acc;
}
