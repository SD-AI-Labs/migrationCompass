/**
 * The vocabulary of an analysis run's lifecycle, and the translation from what is
 * persisted to what a reader is shown.
 *
 * This module is deliberately free of runtime imports. It is imported by the
 * client component that renders live progress, by the server action that reads a
 * run, and by the runner that writes one — so the mapping is defined once and the
 * browser shares the server's vocabulary verbatim rather than re-deriving labels
 * from a second, drifting copy.
 *
 * The status and step values are asserted against the Drizzle enums in
 * `progress.test.ts`. They are literals rather than imports of the schema because
 * importing `@/db/schema` would pull `drizzle-orm/pg-core` into the client bundle
 * to obtain two string unions.
 *
 * What is shown is only ever what is persisted: there is no percentage, no
 * interpolated stage, and no client-side timer. A stage appears when the run row
 * records it, and for exactly as long as it records it.
 */

export const RUN_STATUSES = ["pending", "running", "complete", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `finalizing` is the results write: findings and dependency edges are stored and
 * the run is closed. It is a real persisted step rather than an inferred one so
 * that the last phase of a run — which writes every finding and edge — is visible
 * as its own stage instead of looking like a stuck final agent stage.
 */
export const RUN_STEPS = [
  "discovery",
  "architecture",
  "risk",
  "comparison",
  "finalizing",
  "done",
] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/** The stages a run passes through while it is in flight, in the order reached. */
export const ANALYSIS_STAGES = [
  "starting",
  "discovery",
  "architecture",
  "risk",
  "comparison",
  "finalizing",
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** What the UI highlights: an in-flight stage, or one of the two terminal states. */
export type AnalysisStageId = AnalysisStage | "complete" | "failed";

export const STAGE_LABELS: Record<AnalysisStageId, string> = {
  starting: "Starting analysis",
  discovery: "Discovery analysis",
  architecture: "Architecture analysis",
  risk: "Risk analysis",
  comparison: "Comparison analysis",
  finalizing: "Finalizing results",
  complete: "Complete",
  failed: "Failed",
};

/** The label for a persisted step. `done` is the completed run, not a stage. */
export function labelForStep(step: RunStep | null): string {
  if (step === null) return STAGE_LABELS.starting;
  return step === "done" ? STAGE_LABELS.complete : STAGE_LABELS[step];
}

/** A run that has not finished: the UI must keep watching it. */
export function isActiveStatus(status: RunStatus | "none"): boolean {
  return status === "pending" || status === "running";
}

/** A run that will not change again: the UI can stop watching it. */
export function isTerminalStatus(status: RunStatus | "none"): boolean {
  return status === "complete" || status === "failed";
}

export type AnalysisProgress = {
  /** Null when the project has no run at all. */
  runId: string | null;
  status: RunStatus | "none";
  step: RunStep | null;
  /** The stage to highlight now: an in-flight stage, `complete`, or `failed`. */
  stage: AnalysisStageId;
  /** Human label for {@link AnalysisProgress.stage}. */
  stageLabel: string;
  /** ISO timestamps — this crosses the server/client boundary and must serialize. */
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

/** The state of a project that has never been analysed. */
export function absentProgress(): AnalysisProgress {
  return {
    runId: null,
    status: "none",
    step: null,
    stage: "starting",
    stageLabel: STAGE_LABELS.starting,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

/** Structurally satisfied by `RunRecord`; declared here so this module stays import-free. */
export type ProgressRunInput = {
  id: string;
  status: RunStatus;
  step: RunStep;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export function toAnalysisProgress(run: ProgressRunInput): AnalysisProgress {
  const stage = stageFor(run.status, run.step);

  return {
    runId: run.id,
    status: run.status,
    step: run.step,
    stage,
    stageLabel: STAGE_LABELS[stage],
    startedAt: run.createdAt.toISOString(),
    finishedAt: run.completedAt ? run.completedAt.toISOString() : null,
    error: run.error,
  };
}

/**
 * The stage a persisted run is in.
 *
 * A failed run reports `failed`: the stage it died in is still on `step`, and the
 * caller composes "failed during X" from it rather than this function inventing a
 * label that hides which stage broke.
 */
function stageFor(status: RunStatus, step: RunStep): AnalysisStageId {
  if (status === "failed") return "failed";
  if (status === "complete" || step === "done") return "complete";
  if (status === "pending") return "starting";
  return step;
}

export type StageState = {
  id: AnalysisStage;
  label: string;
  state: "done" | "current" | "pending" | "failed";
};

/**
 * The stage checklist for a run, derived only from persisted state.
 *
 * The inference is bounded by what the graph's shape actually guarantees:
 * Discovery always precedes both branches, and Comparison has two predecessors,
 * so "beyond Comparison" proves both branches finished. Nothing is claimed about
 * the two concurrent branches while they are the furthest step reached — either
 * may have finished and either may be partway through, and saying otherwise would
 * be inventing progress.
 */
export function stageChecklist(run: { status: RunStatus | "none"; step: RunStep | null }): StageState[] {
  const pending = (): StageState[] =>
    ANALYSIS_STAGES.map((id) => ({ id, label: STAGE_LABELS[id], state: "pending" as const }));

  if (run.status === "none") return pending();

  const { status } = run;
  // A run row always carries a step; the default only covers the type's optionality.
  const step = run.step ?? "discovery";
  const beyondDiscovery =
    step === "architecture" || step === "risk" || step === "comparison" || step === "finalizing" || step === "done";
  // Comparison waits for both branches, so reaching it — or anything after it —
  // is proof that both completed.
  const beyondBranches = step === "comparison" || step === "finalizing" || step === "done";
  const beyondComparison = step === "finalizing" || step === "done";
  const beyondFinalizing = step === "done";

  const done = new Set<AnalysisStage>(["starting"]);
  if (status === "pending") done.delete("starting");
  if (beyondDiscovery) done.add("discovery");
  if (beyondBranches) {
    done.add("architecture");
    done.add("risk");
  }
  if (beyondComparison) done.add("comparison");
  if (beyondFinalizing) done.add("finalizing");

  const current: AnalysisStage | null =
    status === "running" ? (step === "done" ? null : step) : status === "pending" ? "starting" : null;

  return ANALYSIS_STAGES.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    state:
      status === "failed" && id === step
        ? "failed"
        : done.has(id)
          ? "done"
          : id === current
            ? "current"
            : "pending",
  }));
}
