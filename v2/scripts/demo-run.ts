/**
 * Runs the analysis for the sample fixture with a deterministic, fixture-derived
 * script instead of a model, so the scorecard and dependency graph can be
 * demonstrated and screenshotted without an API key.
 *
 *   pnpm seed:sample        # ingest the fixture first
 *   pnpm demo:run           # then produce a completed run for it
 *
 * What this is NOT: a model run. Discovery, Architecture, Risk and Comparison
 * outputs here come from `fixtures/sample-legacy-api.expected.json` — the
 * hand-written statement of what the fixture is designed to expose — and every
 * narrative this writes begins with the disclosure below so a completed run can
 * never be mistaken for something the pipeline inferred from the code.
 *
 * What this IS useful for: exercising the full persisted path (run → findings →
 * edges → structured outputs → scorecard → graph) with no LLM, which is exactly
 * what M4 consumes. Real analyses still start from the app, where they need a
 * working model credential.
 */

import { closeDb, hasDatabaseConfig } from "@/db/client";
import { createFakeModel, createFakeTools, architectureJson, comparisonJson, riskJson } from "@/lib/agents/testing/fake-model";
import { runAnalysis } from "@/lib/agents/run";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "@/lib/agents/stores";
import { saveRefinementForOwner } from "@/lib/operational/repository";
import { getProjectForOwner, listProjectsForOwner } from "@/lib/projects/repository";
import { loadScorecardForProject } from "@/lib/scoring/loader";
import { explainScorecard } from "@/lib/scoring/explain";
import { loadSampleFixtureExpectation, sampleOperationalEntries, sampleOperationalFileNames } from "@/lib/testing/sample-fixture";

const DEFAULT_OWNER_ID = "sample-fixture";

/** Prepended to every narrative so the run row discloses how it was produced. */
const DISCLOSURE =
  "[DETERMINISTIC DEMO RUN — structured output derived from the fixture's checked-in " +
  "expectation, no model was called]";

type Args = { ownerId: string; operational: "healthy" | "degraded" | "none" };

function parseArgs(argv: string[]): Args {
  let ownerId = process.env.MC_OWNER_ID ?? DEFAULT_OWNER_ID;
  let operational: Args["operational"] = "healthy";

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--owner") {
      ownerId = argv[index + 1] ?? ownerId;
      index += 1;
    } else if (argv[index] === "--operational") {
      const value = argv[index + 1];
      if (value === "healthy" || value === "degraded" || value === "none") operational = value;
      index += 1;
    }
  }

  return { ownerId, operational };
}

function discoveryFromFixture(): string {
  const expectation = loadSampleFixtureExpectation();

  return JSON.stringify({
    systemName: "sample-legacy-api",
    summary: "Three legacy WebLogic services sharing one Oracle schema.",
    services: expectation.services.map((service) => ({
      name: service.name,
      riskLevel: service.riskLevel,
      riskFactors: service.evidence,
      recommendation: `Address ${service.evidence.length} recorded signal(s) before migration.`,
      hasTestCoverageGap: service.hasTestCoverageGap,
      dataQualityIssueCount: service.dataQualityIssueCount,
      requiresMajorRestructuring: service.requiresMajorRestructuring,
    })),
    dependencies: expectation.dependencies.map((dependency) => ({
      from: dependency.from,
      to: dependency.to,
      type: dependency.type === "sync_call" ? "synchronous call" : "external api",
      evidence: dependency.evidence,
    })),
    techStack: ["Java EE", "WebLogic", "Oracle"],
    databaseOverview: "Single Oracle schema shared by all three services.",
    messagingOverview: "None — every integration is a synchronous HTTP call.",
    externalIntegrations: "Payment processor only.",
    runtimeIssues: "Duplicate charges after browser retries; stale cached customer names.",
  });
}

function script() {
  const expectation = loadSampleFixtureExpectation();

  return {
    "discovery.draft": `${DISCLOSURE} Discovery narrative for the sample fixture.`,
    "discovery.critique": "Complete",
    "discovery.extract": discoveryFromFixture(),
    "architecture.draft": `${DISCLOSURE} Architecture narrative for the sample fixture.`,
    "architecture.critique": "Complete",
    "architecture.extract": architectureJson({
      currentArchitectureLargelySound: false,
      phasedPlan: [
        {
          phaseNumber: 1,
          title: "Extract customer-service",
          servicesInvolved: ["customer-service"],
          rationale: "Read path, no dependencies of its own.",
        },
        {
          phaseNumber: 2,
          title: "Extract order-service",
          servicesInvolved: ["order-service"],
          rationale: "Write path; depends on customer-service and payment-service.",
        },
        {
          phaseNumber: 3,
          title: "Rebuild payment-service",
          servicesInvolved: ["payment-service"],
          rationale: "Requires major restructuring before it can move.",
        },
      ],
    }),
    "risk.draft": `${DISCLOSURE} Risk narrative for the sample fixture.`,
    "risk.critique": "Complete",
    "risk.extract": riskJson({
      ranked: expectation.services.map((service) => ({
        serviceName: service.name,
        riskLevel: service.riskLevel,
        reasoning: service.evidence[0],
        evidenceSource: "static_analysis",
      })),
      operationalDataAvailable: false,
    }),
    "comparison.draft": `${DISCLOSURE} Comparison narrative for the sample fixture.`,
    "comparison.extract": comparisonJson(),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!hasDatabaseConfig()) {
    process.stderr.write("No DATABASE_URL is configured. Run pnpm seed:sample first.\n");
    return 1;
  }

  const projects = await listProjectsForOwner(args.ownerId);
  if (projects.length === 0) {
    process.stderr.write(
      `Owner "${args.ownerId}" has no projects. Run pnpm seed:sample first.\n`,
    );
    return 1;
  }

  // Newest first, in case the fixture was ingested more than once.
  const project = [...projects].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!project) {
    process.stderr.write("No project found to analyse.\n");
    return 1;
  }

  process.stdout.write(`Owner:   ${args.ownerId}\nProject: ${project.name} (${project.id})\n`);
  process.stdout.write("Running the deterministic demo analysis...\n");
  const model = createFakeModel(script());
  const tools = createFakeTools();

  const run = await runAnalysis({
    ownerId: args.ownerId,
    projectId: project.id,
    deps: {
      llm: model.llm,
      tools: tools.tools,
      runStore: createDrizzleRunStore(),
      analysisStore: createDrizzleAnalysisStore(),
      resolveProject: async (requestingOwner: string, requestedProjectId: string) => {
        const found = await getProjectForOwner(requestingOwner, requestedProjectId);
        return found ? { id: found.id, name: found.name } : null;
      },
    },
  });

  process.stdout.write(`\nRun ${run.runId}\n`);

  // The M5 half of the demo: attach the checked-in operational data fixture, so the
  // refined scorecard is visible in the browser without an upload. Clearly labelled,
  // and skippable with `--operational none` to reproduce the code-only baseline.
  if (args.operational !== "none") {
    const parsed = sampleOperationalEntries(args.operational);
    if (parsed.errors.length > 0) {
      process.stderr.write(
        `The ${args.operational} operational fixture did not parse: ${parsed.errors
          .map((error) => error.error)
          .join("; ")}\n`,
      );
      return 1;
    }

    const existing = await loadScorecardForProject(args.ownerId, project.id);
    if (existing && existing.refinement.operational.entries > 0) {
      process.stdout.write(
        `Operational data: ${existing.refinement.operational.entries} file(s) already attached — leaving them as they are.\n`,
      );
    } else {
      const saved = await saveRefinementForOwner(args.ownerId, project.id, { entries: parsed.entries });
      process.stdout.write(
        `Operational data: attached the "${args.operational}" fixture ` +
          `(${sampleOperationalFileNames(args.operational).join(", ")}) — ${saved?.addedEntries ?? 0} file(s).\n`,
      );
    }
  } else {
    process.stdout.write("Operational data: skipped (--operational none) — the estimate stays code-only.\n");
  }

  const loaded = await loadScorecardForProject(args.ownerId, project.id);
  if (!loaded) {
    process.stderr.write("The run completed but no scorecard could be loaded.\n");
    return 1;
  }

  const explanation = explainScorecard(loaded.input);
  const baseline = loaded.baseline;

  process.stdout.write(
    "\nScorecard read back from the database:\n" +
      (loaded.refinement.changed
        ? `  Code-only baseline   readiness ${baseline.readiness.toFixed(1)} · risk ${baseline.risk.toFixed(1)} · ` +
          `effort ${baseline.effort.toFixed(1)} · cost USD ${Math.round(baseline.cost).toLocaleString("en-US")}\n`
        : "") +
      `  Migration Readiness  ${loaded.scorecard.readiness.toFixed(1)} / 100\n` +
      `  Risk                 ${loaded.scorecard.risk.toFixed(1)} / 100` +
      (loaded.scorecard.riskDelta !== 0
        ? ` (${loaded.scorecard.riskDelta > 0 ? "+" : ""}${loaded.scorecard.riskDelta.toFixed(1)} from operational data)\n`
        : "\n") +
      `  Effort               ${loaded.scorecard.effort.toFixed(1)} / 10\n` +
      `  Cost                 USD ${Math.round(loaded.scorecard.cost).toLocaleString("en-US")}\n` +
      `  Time                 ${loaded.scorecard.time.weeksMin}–${loaded.scorecard.time.weeksMax} weeks ` +
      `(${loaded.scorecard.time.band.label})\n` +
      `  Confidence           ${loaded.scorecard.confidence.label} · ` +
      `${loaded.scorecard.confidence.evidence.level} evidence\n` +
      `  Services / edges     ${loaded.scorecard.counts.services} / ${loaded.scorecard.counts.dependencies}\n`,
  );
  process.stdout.write(
    `  Risk breakdown       ${explanation.scores.risk.contributions
      .map((item) => `${item.label} ${item.value.toFixed(1)}`)
      .join(", ")}\n`,
  );
  process.stdout.write(`  Refinement           ${loaded.refinement.description}\n`);

  process.stdout.write(
    "\nOpen the app with this session cookie to see it:\n" +
      `  document.cookie = "mc_owner=${args.ownerId}; path=/"\n`,
  );

  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
