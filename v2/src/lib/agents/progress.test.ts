import { describe, expect, it } from "vitest";

import { runStatusEnum, runStepEnum } from "@/db/schema";

import {
  RUN_STATUSES,
  RUN_STEPS,
  absentProgress,
  isActiveStatus,
  isTerminalStatus,
  labelForStep,
  stageChecklist,
  toAnalysisProgress,
  type RunStatus,
  type RunStep,
} from "./progress";

/**
 * The progress vocabulary is the contract between three layers that must agree: the
 * database enum the runner writes, the server action that reads a run back, and the
 * client component that renders it. These tests pin the mapping itself — what a
 * persisted combination is shown as — because a wrong label here is a false
 * statement about what the analysis is doing, not a cosmetic bug.
 */

function run(overrides: {
  status?: RunStatus;
  step?: RunStep;
  error?: string | null;
  completedAt?: Date | null;
}) {
  return {
    id: "run-1",
    status: overrides.status ?? "running",
    step: overrides.step ?? "discovery",
    error: overrides.error ?? null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    completedAt: overrides.completedAt ?? null,
  };
}

describe("the persisted vocabulary matches the database enums", () => {
  it("lists exactly the run statuses the schema allows", () => {
    // Drift here is silent and expensive: a status the UI does not know about would
    // fall through to a default label while the database happily stored it.
    expect([...runStatusEnum.enumValues].sort()).toEqual([...RUN_STATUSES].sort());
  });

  it("lists exactly the run steps the schema allows", () => {
    expect([...runStepEnum.enumValues].sort()).toEqual([...RUN_STEPS].sort());
  });

  it("includes the results-write step as a persisted stage", () => {
    expect(RUN_STEPS).toContain("finalizing");
    expect(runStepEnum.enumValues).toContain("finalizing");
  });
});

describe("toAnalysisProgress", () => {
  it("reports a queued run as starting", () => {
    const progress = toAnalysisProgress(run({ status: "pending" }));
    expect(progress.stage).toBe("starting");
    expect(progress.stageLabel).toBe("Starting analysis");
    expect(progress.finishedAt).toBeNull();
    expect(isActiveStatus(progress.status)).toBe(true);
  });

  it("reports the persisted step of a running run", () => {
    const progress = toAnalysisProgress(run({ status: "running", step: "architecture" }));
    expect(progress.stage).toBe("architecture");
    expect(progress.stageLabel).toBe("Architecture analysis");
    expect(progress.startedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(isTerminalStatus(progress.status)).toBe(false);
  });

  it("reports a completed run as complete with a finish time", () => {
    const completedAt = new Date("2026-01-02T03:20:00.000Z");
    const progress = toAnalysisProgress(
      run({ status: "complete", step: "done", completedAt }),
    );

    expect(progress.stage).toBe("complete");
    expect(progress.finishedAt).toBe(completedAt.toISOString());
    expect(isTerminalStatus(progress.status)).toBe(true);
  });

  it("keeps the failing step and the message on a failed run", () => {
    const progress = toAnalysisProgress(
      run({ status: "failed", step: "risk", error: "risk model exploded" }),
    );

    expect(progress.stage).toBe("failed");
    // The step is not discarded: "failed during Risk analysis" is the useful part.
    expect(progress.step).toBe("risk");
    expect(labelForStep(progress.step)).toBe("Risk analysis");
    expect(progress.error).toBe("risk model exploded");
    expect(isTerminalStatus(progress.status)).toBe(true);
  });

  it("reports a project with no run as absent and inactive", () => {
    const progress = absentProgress();
    expect(progress.runId).toBeNull();
    expect(progress.status).toBe("none");
    expect(isActiveStatus(progress.status)).toBe(false);
    expect(isTerminalStatus(progress.status)).toBe(false);
  });

  it("serializes every field a client component needs", () => {
    // The value crosses the server/client boundary; Dates and undefined do not.
    const progress = toAnalysisProgress(run({ status: "running", step: "comparison" }));
    const roundTripped = JSON.parse(JSON.stringify(progress)) as typeof progress;
    expect(roundTripped).toEqual(progress);
    expect(Object.values(progress).every((value) => typeof value !== "object" || value === null)).toBe(
      true,
    );
  });
});

describe("stageChecklist", () => {
  const byId = (status: RunStatus | "none", step: RunStep | null) =>
    Object.fromEntries(stageChecklist({ status, step }).map((stage) => [stage.id, stage.state]));

  it("shows only the starting stage as current while a run is queued", () => {
    expect(byId("pending", "discovery")).toEqual({
      starting: "current",
      discovery: "pending",
      architecture: "pending",
      risk: "pending",
      comparison: "pending",
      finalizing: "pending",
    });
  });

  it("marks discovery done once the run has moved past it", () => {
    const states = byId("running", "architecture");
    expect(states.starting).toBe("done");
    expect(states.discovery).toBe("done");
    expect(states.architecture).toBe("current");
  });

  it("does not claim either concurrent branch finished while one is running", () => {
    // Architecture and Risk run in parallel; the persisted step names only one of
    // them, so neither can be reported as done.
    const states = byId("running", "risk");
    expect(states.architecture).toBe("pending");
    expect(states.risk).toBe("current");
  });

  it("marks both branches done once the join stage is reached", () => {
    // Comparison waits for both, so reaching it proves both completed.
    const states = byId("running", "comparison");
    expect(states.architecture).toBe("done");
    expect(states.risk).toBe("done");
    expect(states.comparison).toBe("current");
    expect(states.finalizing).toBe("pending");
  });

  it("shows the results write as its own current stage", () => {
    const states = byId("running", "finalizing");
    expect(states.comparison).toBe("done");
    expect(states.finalizing).toBe("current");
  });

  it("marks every stage done on completion", () => {
    const states = byId("complete", "done");
    expect(Object.values(states).every((state) => state === "done")).toBe(true);
  });

  it("marks the stage a run died in as failed and leaves the rest honestly unknown", () => {
    const states = byId("failed", "risk");
    expect(states.starting).toBe("done");
    expect(states.discovery).toBe("done");
    expect(states.risk).toBe("failed");
    expect(states.architecture).toBe("pending");
  });

  it("leaves every stage untouched when there is no run", () => {
    const states = byId("none", null);
    expect(Object.values(states).every((state) => state === "pending")).toBe(true);
  });

  it("labels the stages in the order they are reached", () => {
    expect(stageChecklist({ status: "running", step: "discovery" }).map((stage) => stage.label)).toEqual([
      "Starting analysis",
      "Discovery analysis",
      "Architecture analysis",
      "Risk analysis",
      "Comparison analysis",
      "Finalizing results",
    ]);
  });
});
