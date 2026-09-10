import type { LlmClient } from "@/lib/llm/client";

import { runAnalysisGraph, type AgentDeps, type AnalysisOutcome } from "./graph";
import { persistAnalysis, type AnalysisStore, type PersistencePlan } from "./persistence";
import type { AgentStage } from "./prompts";
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

export type RunStatus = "pending" | "running" | "complete" | "failed";
export type RunStep = AgentStage | "done";

export const RUN_STEPS: RunStep[] = ["discovery", "architecture", "risk", "comparison", "done"];

export type RunRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  status: RunStatus;
  step: RunStep;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type RunReports = {
  discoveryReport: string;
  architectureProposal: string;
  riskAssessment: string;
  comparisonReport: string;
};

export type RunStore = {
  /** Persists a new run in `pending`. */
  create(input: { projectId: string; ownerId: string }): Promise<{ id: string }>;
  markRunning(runId: string): Promise<void>;
  /** Advances `step` while the run is in progress. */
  advanceStep(runId: string, step: RunStep): Promise<void>;
  complete(runId: string, reports: RunReports): Promise<void>;
  /** Must never throw: it is called from a failure path that has an error to report. */
  fail(runId: string, input: { stage: RunStep; message: string }): Promise<void>;
  getRun(ownerId: string, runId: string): Promise<RunRecord | null>;
  latestRun(ownerId: string, projectId: string): Promise<RunRecord | null>;
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
 */
export async function executeAnalysisRun(input: {
  runId: string;
  projectId: string;
  deps: Omit<RunDeps, "resolveProject">;
}): Promise<{ runId: string; outcome: AnalysisOutcome; persisted: PersistencePlan }> {
  const { runId, projectId, deps } = input;

  // Tracks the furthest stage reached, so a failure knows where it happened even
  // though the graph's own record only exists on success.
  let currentStage: RunStep = "discovery";

  try {
    await deps.runStore.markRunning(runId);

    const graphDeps: AgentDeps = {
      llm: deps.llm,
      tools: deps.tools,
      maxToolIterations: deps.maxToolIterations,
      onStageStart: async (stage) => {
        currentStage = stage;
        await deps.runStore.advanceStep(runId, stage);
      },
    };

    const outcome = await runAnalysisGraph({ projectId, runId, deps: graphDeps });

    const persisted = await persistAnalysis(deps.analysisStore, {
      runId,
      projectId,
      discovery: outcome.discovery.structured,
      risk: outcome.risk.structured,
    });

    currentStage = "done";
    await deps.runStore.complete(runId, {
      discoveryReport: outcome.discovery.narrative,
      architectureProposal: outcome.architecture.narrative,
      riskAssessment: outcome.risk.narrative,
      comparisonReport: outcome.comparison.narrative,
    });

    return { runId, outcome, persisted };
  } catch (error) {
    const detail = describeError(error);

    // The failure record must survive even if the original error is confusing —
    // but a store that is itself broken must not replace the real error.
    try {
      await deps.runStore.fail(runId, { stage: currentStage, message: detail });
    } catch {
      // Deliberately swallowed: the run cannot be marked failed if the database is
      // unreachable, and that is strictly better than losing the original error.
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
