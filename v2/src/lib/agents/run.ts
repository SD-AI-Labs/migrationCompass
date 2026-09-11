import type { LlmClient } from "@/lib/llm/client";
import { getLogger } from "@/lib/observability/logger";

import { runAnalysisGraph, type AgentDeps, type AnalysisOutcome } from "./graph";
import { persistAnalysis, type AnalysisStore, type PersistencePlan } from "./persistence";
import { RUN_STEPS as RUN_STEP_VALUES, STAGE_LABELS, type RunStatus, type RunStep } from "./progress";
import type { SharedTools } from "./tools";

/**
 * The analysis run: lifecycle, ownership, and failure semantics.
 *
 * ## Run states
 *
 * `pending → running → complete | failed`, persisted to `analysis_runs` at each
 * transition, with `step` recording which major stage was reached. The states are
 * persisted rather than held in memory so progress is pollable from the database
 * by whatever is watching the run — which is the M4 requirement, and the reason
 * `pending` was added to the schema: a row created but not yet started must not
 * claim to be running. If the process dies between create and start, the run is
 * visibly `pending` forever instead of invisibly `running` forever, and those two
 * are very different things to whoever is looking at the page.
 *
 * `step` advances through the graph's own stages — discovery, then architecture and
 * risk concurrently, then comparison — and finishes with `finalizing`, which is the
 * results write, before `done`. Those are the only stages a reader is ever told
 * about; there is no interpolated stage and no percentage, because the database has
 * no such thing to report.
 *
 * Who watches the run is the other half of the contract: `readAnalysisProgressAction`
 * reads the row back for the client component that polls it, and that component
 * re-renders the page once this runner has written a terminal state. Nothing else
 * can — the page is a server render, and the action that started the run returned
 * while it was still queued.
 *
 * ## Failure is a persisted state, not an exception
 *
 * Every failure marks the run `failed` with the stage it died in and the message.
 * A run is never left `running` because something threw. The original error is
 * still rethrown as `AnalysisFailedError` so a caller that cares can act on it,
 * but the database already records what happened, independent of whether anyone
 * caught the exception.
 *
 * ## Ownership
 *
 * The project is resolved through an injected resolver that is owner-scoped, and
 * a project belonging to another session resolves to null — so a run cannot be
 * started against someone else's codebase even with a valid project id.
 */

/**
 * Re-exported from `./progress`, which owns the values as literals so the client
 * component can share them without pulling a database schema into the bundle.
 * `progress.test.ts` asserts they match the `run_status` / `run_step` enums.
 */
export type { RunStatus, RunStep };

/** Every step a run can be in, in the order it reaches them. */
export const RUN_STEPS: RunStep[] = [...RUN_STEP_VALUES];

export type RunRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  status: RunStatus;
  step: RunStep;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /** Null for runs recorded before the structured outputs were persisted. */
  outputs: {
    discovery: Record<string, unknown> | null;
    architecture: Record<string, unknown> | null;
    risk: Record<string, unknown> | null;
    comparison: Record<string, unknown> | null;
  };
};

export type RunReports = {
  discoveryReport: string;
  architectureProposal: string;
  riskAssessment: string;
  comparisonReport: string;
};

/**
 * The validated structured outputs behind those narratives.
 *
 * Persisted alongside the reports because the scoring engine consumes them as
 * data — `currentArchitectureLargelySound`, the phased plan — and must not
 * re-parse prose to recover them.
 */
export type RunOutputs = {
  discovery: Record<string, unknown>;
  architecture: Record<string, unknown>;
  risk: Record<string, unknown>;
  comparison: Record<string, unknown>;
};

export type RunStore = {
  /** Persists a new run in `pending`. */
  create(input: { projectId: string; ownerId: string }): Promise<{ id: string }>;
  markRunning(runId: string): Promise<void>;
  /** Advances `step` while the run is in progress. */
  advanceStep(runId: string, step: RunStep): Promise<void>;
  complete(runId: string, reports: RunReports, outputs: RunOutputs): Promise<void>;
  /** Must never throw: it is called from a failure path that has an error to report. */
  fail(runId: string, input: { stage: RunStep; message: string }): Promise<void>;
  getRun(ownerId: string, runId: string): Promise<RunRecord | null>;
  latestRun(ownerId: string, projectId: string): Promise<RunRecord | null>;
  /**
   * The most recent *completed* run for a project.
   *
   * Distinct from `latestRun` because a project can have a run in flight while an
   * earlier one finished: the scorecard has to be built from the newest run that
   * actually produced findings, not from whichever row happens to be newest.
   */
  latestCompletedRun(ownerId: string, projectId: string): Promise<RunRecord | null>;
};

/** The resolved project, already proven to belong to the requesting session. */
export type ResolvedProject = { id: string; name: string };

export type RunDeps = {
  llm: LlmClient;
  tools: SharedTools;
  runStore: RunStore;
  analysisStore: AnalysisStore;
  /** Owner-scoped lookup. Returns null when the project does not exist *or* belongs to another session. */
  resolveProject: (ownerId: string, projectId: string) => Promise<ResolvedProject | null>;
  maxToolIterations?: number;
};

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(
      `No project ${projectId} is visible to this session. It either does not exist or belongs to ` +
        `another session — those are deliberately indistinguishable.`,
    );
    this.name = "ProjectNotFoundError";
  }
}

export class AnalysisFailedError extends Error {
  constructor(
    readonly stage: RunStep,
    readonly runId: string,
    readonly detail: string,
  ) {
    super(`The analysis failed during the ${stage} stage: ${detail}`);
    this.name = "AnalysisFailedError";
  }
}

/**
 * Collects the message chain from an error and its causes.
 *
 * LangGraph wraps a node's failure in its own error type, so the message that
 * actually explains what went wrong is frequently one level down in `cause`.
 * Reporting only the wrapper would produce run records that say "node failed" and
 * nothing else, which is useless for diagnosing a bad run — the whole point of
 * persisting the failure.
 */
export function describeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (message.length > 0 && !messages.includes(message)) messages.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }

  if (messages.length === 0) return "Unknown error with no message.";
  // Deepest last, so the chain reads outer-cause-then-detail.
  return messages.reverse().join(" ← ");
}

/**
 * Records a step, tolerating a database that cannot store it.
 *
 * `finalizing` is the newest value in the `run_step` enum, so a database that has
 * not had the migration applied yet cannot store it. That must not fail a run whose
 * results are otherwise complete — losing an analysis over a progress label would
 * be absurd — so the failure is logged and the run carries on with the previous
 * step on record.
 */
async function recordStep(
  deps: Omit<RunDeps, "resolveProject">,
  input: { projectId: string; runId: string },
  step: RunStep,
): Promise<boolean> {
  try {
    await deps.runStore.advanceStep(input.runId, step);
    return true;
  } catch (error) {
    getLogger().warn(
      { error, runId: input.runId, projectId: input.projectId, stage: step },
      "Could not record the analysis step",
    );
    return false;
  }
}

/**
 * Executes an already-created run.
 *
 * Separated from creation so a caller can create the run, return its id to the
 * page immediately, and execute afterwards — the run is visible as `pending`
 * while that happens, which is what makes progress pollable rather than
 * request-bound.
 *
 * Takes the deps without `resolveProject`: ownership was already proven when the
 * run was created, and a second lookup here would be a second chance to get the
 * scoping wrong.
 *
 * The lifecycle is logged here rather than in the server action because this is
 * where the run actually happens — and because scripts (`demo:run`, `seed:sample`)
 * call it directly, so one set of lines covers every caller. Every line carries
 * `projectId`, `runId` and `stage`; none carries source text or credentials.
 */
export async function executeAnalysisRun(input: {
  runId: string;
  projectId: string;
  deps: Omit<RunDeps, "resolveProject">;
}): Promise<{ runId: string; outcome: AnalysisOutcome; persisted: PersistencePlan }> {
  const { runId, projectId, deps } = input;
  const logger = getLogger();
  const startedAt = Date.now();

  // Tracks the furthest stage reached, so a failure knows where it happened even
  // though the graph's own record only exists on success.
  let currentStage: RunStep = "discovery";

  try {
    await deps.runStore.markRunning(runId);
    logger.info({ projectId, runId, stage: currentStage }, "Analysis run started");

    const graphDeps: AgentDeps = {
      llm: deps.llm,
      tools: deps.tools,
      maxToolIterations: deps.maxToolIterations,
      onStageStart: async (stage) => {
        currentStage = stage;
        await deps.runStore.advanceStep(runId, stage);
        logger.info(
          { projectId, runId, stage, elapsedMs: Date.now() - startedAt },
          `${STAGE_LABELS[stage]} started`,
        );
      },
      onStageEnd: (stage, info) => {
        // Timed inside the stage, not between transitions: Architecture and Risk
        // run concurrently, so a stage-to-stage delta would attribute their overlap
        // to whichever reported last.
        logger.info(
          {
            projectId,
            runId,
            stage,
            durationMs: info.durationMs,
            toolCalls: info.toolCalls,
            elapsedMs: Date.now() - startedAt,
          },
          `${STAGE_LABELS[stage]} completed`,
        );
      },
    };

    const outcome = await runAnalysisGraph({ projectId, runId, deps: graphDeps });

    const toolCalls = [
      outcome.discovery.toolCalls,
      outcome.architecture.toolCalls,
      outcome.risk.toolCalls,
      outcome.comparison.toolCalls,
    ].reduce((total, count) => total + count, 0);

    // The results write, as its own persisted step: it stores every finding and
    // edge, and on a large codebase it is the longest thing between the last agent
    // finishing and the scorecard existing.
    currentStage = "finalizing";
    const finalizingStartedAt = Date.now();
    await recordStep(deps, { projectId, runId }, "finalizing");
    logger.info(
      { projectId, runId, stage: "finalizing", elapsedMs: finalizingStartedAt - startedAt },
      `${STAGE_LABELS.finalizing} started`,
    );

    const persisted = await persistAnalysis(deps.analysisStore, {
      runId,
      projectId,
      discovery: outcome.discovery.structured,
      risk: outcome.risk.structured,
    });

    logger.info(
      {
        projectId,
        runId,
        stage: "finalizing",
        durationMs: Date.now() - finalizingStartedAt,
        findings: persisted.findings.length,
        dependencies: persisted.dependencies.length,
        undiscoveredServices: persisted.undiscoveredServices.length,
        toolCalls,
      },
      `${STAGE_LABELS.finalizing} completed`,
    );

    currentStage = "done";
    await deps.runStore.complete(
      runId,
      {
        discoveryReport: outcome.discovery.narrative,
        architectureProposal: outcome.architecture.narrative,
        riskAssessment: outcome.risk.narrative,
        comparisonReport: outcome.comparison.narrative,
      },
      // Spread into fresh literals: the stage outputs are typed objects, and the
      // persistence boundary stores them as plain JSON for the scoring engine to
      // validate on read.
      {
        discovery: { ...outcome.discovery.structured },
        architecture: { ...outcome.architecture.structured },
        risk: { ...outcome.risk.structured },
        comparison: { ...outcome.comparison.structured },
      },
    );

    logger.info(
      {
        projectId,
        runId,
        stage: "complete",
        durationMs: Date.now() - startedAt,
        findings: persisted.findings.length,
        dependencies: persisted.dependencies.length,
        toolCalls,
      },
      "Analysis run completed",
    );

    return { runId, outcome, persisted };
  } catch (error) {
    const detail = describeError(error);

    // Logged before the store write: the error is the thing being reported, and a
    // log that only happens if the database is reachable is a log that goes missing
    // exactly when it is needed. `detail` carries the cause chain in prose — an
    // Error's message is not an own enumerable property, so the `error` object alone
    // would serialize to a shape with no explanation in it.
    logger.error(
      {
        projectId,
        runId,
        stage: currentStage,
        durationMs: Date.now() - startedAt,
        detail,
        error,
      },
      "Analysis run failed",
    );

    // The failure record must survive even if the original error is confusing —
    // but a store that is itself broken must not replace the real error.
    try {
      await deps.runStore.fail(runId, { stage: currentStage, message: detail });
    } catch (failureError) {
      // Deliberately swallowed: the run cannot be marked failed if the database is
      // unreachable, and that is strictly better than losing the original error.
      logger.warn(
        {
          projectId,
          runId,
          errorMessage: failureError instanceof Error ? failureError.message : String(failureError),
        },
        "Could not record the analysis failure",
      );
    }

    throw new AnalysisFailedError(currentStage, runId, detail);
  }
}

/**
 * Creates a run in `pending` and returns its id without starting it.
 *
 * The split exists so the page can render "queued" immediately: `after()` in the
 * server action then executes it, and the user sees a run that exists and is
 * pending rather than a request that appears to hang.
 */
export async function createAnalysisRun(input: {
  ownerId: string;
  projectId: string;
  deps: Pick<RunDeps, "runStore" | "resolveProject">;
}): Promise<{ runId: string; project: ResolvedProject }> {
  const project = await input.deps.resolveProject(input.ownerId, input.projectId);
  if (!project) throw new ProjectNotFoundError(input.projectId);

  // Ownership is proven before anything is written: no run row is created for a
  // project this session cannot see.
  const run = await input.deps.runStore.create({ projectId: project.id, ownerId: input.ownerId });
  return { runId: run.id, project };
}

/** Create and execute in one call. Used by tests and by any synchronous caller. */
export async function runAnalysis(input: {
  ownerId: string;
  projectId: string;
  deps: RunDeps;
}): Promise<{ runId: string; outcome: AnalysisOutcome; persisted: PersistencePlan }> {
  const { runId } = await createAnalysisRun({
    ownerId: input.ownerId,
    projectId: input.projectId,
    deps: input.deps,
  });

  return executeAnalysisRun({ runId, projectId: input.projectId, deps: input.deps });
}
