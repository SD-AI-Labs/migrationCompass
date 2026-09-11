import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { archiveDirectory } from "@/lib/fixtures/archive";
import type { GraphDependencyInput, GraphServiceInput } from "@/lib/graph/build-graph";
import { parseOperationalFiles, type OperationalEntry, type OperationalFile } from "@/lib/scoring/operational";
import type { ScoringDependency, ScoringFinding } from "@/lib/scoring/rubric";

/**
 * Test-side access to the checked-in sample fixture.
 *
 * Reads `fixtures/sample-legacy-api.expected.json` — a hand-written statement of
 * what the fixture is designed to expose, sitting beside the fixture rather than
 * inside it so it is never part of the ingested corpus.
 *
 * This is deliberately NOT a captured model run. Discovery's live output comes from
 * a model and is not deterministic; what these helpers provide is the stable
 * expectation the fixture itself guarantees (three services, a synchronous chain,
 * one external integration, one service needing major restructuring).
 */

/** Absolute path to the fixture source tree. */
export const SAMPLE_FIXTURE_DIR = fileURLToPath(
  new URL("../../../../fixtures/sample-legacy-api", import.meta.url),
);

const EXPECTED_PATH = fileURLToPath(
  new URL("../../../../fixtures/sample-legacy-api.expected.json", import.meta.url),
);

export type SampleFixtureService = {
  name: string;
  riskLevel: ScoringFinding["riskLevel"];
  hasTestCoverageGap: boolean;
  dataQualityIssueCount: number;
  requiresMajorRestructuring: boolean;
  dependentCount: number;
  evidence: string[];
};

export type SampleFixtureDependency = {
  from: string;
  to: string;
  type: string;
  evidence: string;
};

export type SampleFixtureExpectation = {
  services: SampleFixtureService[];
  dependencies: SampleFixtureDependency[];
  inventory: { note: string; external: string[] };
};

export function loadSampleFixtureExpectation(): SampleFixtureExpectation {
  return JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as SampleFixtureExpectation;
}

/** The fixture's services in the shape the scoring rubric consumes. */
export function sampleFixtureFindings(): ScoringFinding[] {
  return loadSampleFixtureExpectation().services.map((service) => ({
    serviceName: service.name,
    riskLevel: service.riskLevel,
    hasTestCoverageGap: service.hasTestCoverageGap,
    dataQualityIssueCount: service.dataQualityIssueCount,
    requiresMajorRestructuring: service.requiresMajorRestructuring,
    dependentCount: service.dependentCount,
  }));
}

/** The fixture's edges in the shape the rubric and the graph builder consume. */
export function sampleFixtureDependencies(): ScoringDependency[] &
  GraphDependencyInput[] {
  return loadSampleFixtureExpectation().dependencies.map((dependency) => ({
    fromService: dependency.from,
    toService: dependency.to,
    type: dependency.type,
  }));
}

export function sampleFixtureGraphServices(): GraphServiceInput[] {
  return sampleFixtureFindings();
}

/** The fixture packed exactly as `pnpm seed:sample` packs it. */
export async function sampleFixtureArchive(): Promise<Uint8Array> {
  return archiveDirectory(SAMPLE_FIXTURE_DIR);
}

/**
 * The checked-in operational data fixtures.
 *
 * Two scenarios, deliberately opposite, because the plan's claim about operational
 * data is bidirectional: it can show a codebase is *more* stable than its code smells
 * suggest, and it can show it is worse. One dataset could not demonstrate both, so
 * there are two.
 *
 * These are the exact files a user attaches in the browser, which is why they are
 * read from disk here rather than written as literals in a test: a fixture that only
 * exists inside a test does not prove the upload path works on a real file.
 */
export type OperationalScenario = "healthy" | "degraded";

export const SAMPLE_OPERATIONAL_DIR = fileURLToPath(
  new URL("../../../../fixtures/sample-legacy-api.operational", import.meta.url),
);

export function sampleOperationalFileNames(scenario: OperationalScenario): string[] {
  return readdirSync(resolve(SAMPLE_OPERATIONAL_DIR, scenario)).sort();
}

/** The scenario's files as the attachment path produces them. */
export function sampleOperationalFiles(scenario: OperationalScenario): OperationalFile[] {
  return sampleOperationalFileNames(scenario).map((name) => ({
    name,
    text: readFileSync(resolve(SAMPLE_OPERATIONAL_DIR, scenario, name), "utf8"),
  }));
}

/** The scenario's files, parsed and validated — the input `recomputeScorecard()` takes. */
export function sampleOperationalEntries(scenario: OperationalScenario): {
  entries: OperationalEntry[];
  errors: { source: string; error: string }[];
} {
  return parseOperationalFiles(sampleOperationalFiles(scenario));
}
