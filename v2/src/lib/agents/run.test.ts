import { describe, expect, it } from "vitest";

import {
  AnalysisFailedError,
  createAnalysisRun,
  executeAnalysisRun,
  ProjectNotFoundError,
  runAnalysis,
  type RunRecord,
  type RunReports,
  type RunStep,
  type RunStore,
} from "./run";
import type { AnalysisStore, NewDependency, NewFinding } from "./persistence";
import {
  architectureJson,
  comparisonJson,
  createFakeModel,
  createFakeTools,
  discoveryJson,
  riskJson,
  type FakeScript,
} from "./testing/fake-model";

/**
 * Run-lifecycle coverage: the persisted state a poller reads, the ownership gate
 * that stops a run touching another session's project, and the failure path that
 * must never leave a run looking in-progress.
 */

type Transition = { status: RunRecord["status"]; step?: RunStep; error?: string | null };

function createFakeRunStore(options: { failThrows?: boolean } = {}) {
  const runs = new Map<string, RunRecord>();
  const transitions: Transition[] = [];
  /** Store operations in order, so "persisted before completed" is checkable. */
  const calls: string[] = [];
  let sequence = 0;

  const store: RunStore = {
    async create({ projectId, ownerId }) {
      calls.push("create");
      sequence += 1;
      const id = `run-${sequence}`;
      runs.set(id, {
        id,
        projectId,
        ownerId,
        status: "pending",
        step: "discovery",
        error: null,
        createdAt: new Date(),
        completedAt: null,
      });
      transitions.push({ status: "pending", step: "discovery" });
      return { id };
    },

    async markRunning(runId) {
      calls.push("markRunning");
      const run = runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      run.status = "running";
      transitions.push({ status: "running" });
    },

    async advanceStep(runId, step) {
      calls.push(`advanceStep:${step}`);
      const run = runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      run.step = step;
      transitions.push({ status: run.status, step });
    },

    async complete(runId, reports: RunReports) {
      calls.push("complete");
      const run = runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      run.status = "complete";
      run.step = "done";
      run.completedAt = new Date();
      void reports;
      transitions.push({ status: "complete", step: "done" });
    },

    async fail(runId, { stage, message }) {
      calls.push("fail");
      if (options.failThrows) throw new Error("database unreachable");
      const run = runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      run.status = "failed";
      run.step = stage;
      run.error = message;
      run.completedAt = new Date();
      transitions.push({ status: "failed", step: stage, error: message });
    },

    async getRun(ownerId, runId) {
      const run = runs.get(runId);
      return run && run.ownerId === ownerId ? run : null;
    },

    async latestRun(ownerId, projectId) {
      return (
        [...runs.values()]
          .filter((run) => run.ownerId === ownerId && run.projectId === projectId)
          .at(-1) ?? null
      );
    },
  };

  return { store, runs, transitions, calls };
}

function createFakeAnalysisStore() {
  const calls: string[] = [];
  const writes: { runId: string; projectId: string; findings: NewFinding[]; dependencies: NewDependency[] }[] = [];

  const store: AnalysisStore = {
    async replaceResults(input) {
      calls.push("replaceResults");
      writes.push(input);
    },
    async findFindings() {
      return [];
    },
    async findDependencies() {
      return [];
    },
  };

  return { store, calls, writes };
}

function script(overrides: FakeScript = {}): FakeScript {
  return {
    "discovery.draft": "discovery narrative marker",
    "discovery.critique": "Complete",
    "discovery.extract": discoveryJson(),
    "architecture.draft": "architecture narrative marker",
    "architecture.critique": "Complete",
    "architecture.extract": architectureJson(),
    "risk.draft": "risk narrative marker",
    "risk.critique": "Complete",
    "risk.extract": riskJson(),
    "comparison.draft": "comparison narrative marker",
    "comparison.extract": comparisonJson(),
    ...overrides,
  };
}

function harness(options: { overrides?: FakeScript; failThrows?: boolean; ownerId?: string } = {}) {
  const model = createFakeModel(script(options.overrides));
  const tools = createFakeTools();
  const runStore = createFakeRunStore({ failThrows: options.failThrows });
  const analysisStore = createFakeAnalysisStore();
  const ownerId = options.ownerId ?? "owner-1";
  const projectOwners = new Map([["project-1", ownerId]]);

  const deps = {
    llm: model.llm,
    tools: tools.tools,
    runStore: runStore.store,
    analysisStore: analysisStore.store,
    resolveProject: async (requestingOwner: string, projectId: string) =>
      projectOwners.get(projectId) === requestingOwner ? { id: projectId, name: "sample.zip" } : null,
  };

  return { model, runStore, analysisStore, deps, ownerId };
}

describe("successful run", () => {
  it("transitions pending → running → each stage → complete", async () => {
    const { runStore, deps, ownerId } = harness();
    const result = await runAnalysis({ ownerId, projectId: "project-1", deps });

    const statuses = runStore.transitions.map((transition) => transition.status);
    expect(statuses[0]).toBe("pending");
    expect(statuses[1]).toBe("running");
    expect(statuses.at(-1)).toBe("complete");

    const record = await runStore.store.getRun(ownerId, result.runId);
    expect(record?.status).toBe("complete");
    expect(record?.step).toBe("done");
    expect(record?.completedAt).toBeInstanceOf(Date);
    expect(record?.error).toBeNull();
  });

  it("records which stage was reached as the run progresses", async () => {
    const { runStore, deps, ownerId } = harness();
    await runAnalysis({ ownerId, projectId: "project-1", deps });

    const steps = runStore.transitions
      .map((transition) => transition.step)
      .filter((step): step is RunStep => step !== undefined);

    // Each major agent step is persisted, so a poller can say where the run is.
    expect(steps).toContain("discovery");
    expect(steps).toContain("architecture");
    expect(steps).toContain("risk");
    expect(steps).toContain("comparison");
    expect(steps.at(-1)).toBe("done");
  });

  it("creates the run in pending before any stage runs", async () => {
    const { runStore, deps, ownerId } = harness();
    const { runId } = await createAnalysisRun({ ownerId, projectId: "project-1", deps });

    // Nothing has executed yet, and the row does not claim otherwise.
    const record = await runStore.store.getRun(ownerId, runId);
    expect(record?.status).toBe("pending");
    expect(runStore.transitions).toEqual([{ status: "pending", step: "discovery" }]);
  });

  it("persists findings and dependencies before marking the run complete", async () => {
    // Order matters: a run that reports `complete` before its results exist would
    // render an empty scorecard for a finished analysis.
    const { runStore, analysisStore, deps, ownerId } = harness();
    await runAnalysis({ ownerId, projectId: "project-1", deps });

    expect(analysisStore.calls).toEqual(["replaceResults"]);
    expect(runStore.calls.indexOf("replaceResults")).toBe(-1);
    expect(runStore.calls.at(-1)).toBe("complete");
  });

  it("writes the results against the run and project that produced them", async () => {
    const { analysisStore, deps, ownerId } = harness();
    const result = await runAnalysis({ ownerId, projectId: "project-1", deps });

    expect(analysisStore.writes[0]).toMatchObject({
      runId: result.runId,
      projectId: "project-1",
    });
    expect(analysisStore.writes[0]?.findings.length).toBeGreaterThan(0);
    expect(analysisStore.writes[0]?.dependencies.length).toBeGreaterThan(0);
  });

  it("returns the four narratives and the structured outputs", async () => {
    const { deps, ownerId } = harness();
    const result = await runAnalysis({ ownerId, projectId: "project-1", deps });

    expect(result.outcome.discovery.narrative).toBe("discovery narrative marker");
    expect(result.outcome.comparison.narrative).toBe("comparison narrative marker");
    expect(result.outcome.risk.structured.ranked).toHaveLength(3);
    expect(result.outcome.completedStages).toEqual([
      "discovery",
      "architecture",
      "risk",
      "comparison",
    ]);
  });
});

describe("ownership", () => {
  it("refuses to analyse a project belonging to another session", async () => {
    const { runStore, deps } = harness({ ownerId: "owner-1" });

    await expect(
      runAnalysis({ ownerId: "someone-else", projectId: "project-1", deps }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // The refusal happens before the run row is created, so the other session's
    // project carries no trace of the attempt.
    expect(runStore.runs.size).toBe(0);
  });

  it("creates no run row for a project the session cannot see", async () => {
    // The gate is before any write, so a rejected request leaves no trace of a run
    // in the other session's project.
    const { runStore, deps } = harness();

    await expect(
      createAnalysisRun({ ownerId: "someone-else", projectId: "project-1", deps }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    expect(runStore.runs.size).toBe(0);
    expect(runStore.calls).toEqual([]);
  });

  it("hides the run from another owner on read", async () => {
    const { runStore, deps, ownerId } = harness();
    const result = await runAnalysis({ ownerId, projectId: "project-1", deps });

    expect(await runStore.store.getRun("someone-else", result.runId)).toBeNull();
    expect(await runStore.store.getRun(ownerId, result.runId)).not.toBeNull();
  });
});

describe("failure", () => {
  it("marks the run failed and never leaves it running", async () => {
    const { runStore, deps, ownerId } = harness({ overrides: { "risk.draft": new Error("risk model exploded") } });

    await expect(runAnalysis({ ownerId, projectId: "project-1", deps })).rejects.toBeInstanceOf(
      AnalysisFailedError,
    );

    const [record] = [...runStore.runs.values()];
    expect(record?.status).toBe("failed");
    expect(record?.status).not.toBe("running");
    expect(record?.completedAt).toBeInstanceOf(Date);
  });

  it("records the stage the failure happened in", async () => {
    const { runStore, deps, ownerId } = harness({ overrides: { "risk.draft": new Error("risk model exploded") } });

    await runAnalysis({ ownerId, projectId: "project-1", deps }).catch(() => undefined);

    const [record] = [...runStore.runs.values()];
    expect(record?.step).toBe("risk");
  });

  it("keeps the underlying message for diagnosis", async () => {
    const { runStore, deps, ownerId } = harness({
      overrides: {
        "discovery.extract": "not json",
        "discovery.extract-retry": "still not json",
      },
    });

    await runAnalysis({ ownerId, projectId: "project-1", deps }).catch(() => undefined);

    const [record] = [...runStore.runs.values()];
    expect(record?.error).toContain("discovery structured output");
    expect(record?.step).toBe("discovery");
  });

  it("reports the failing stage and run id on the thrown error", async () => {
    const { deps, ownerId } = harness({ overrides: { "comparison.draft": new Error("comparison exploded") } });

    try {
      await runAnalysis({ ownerId, projectId: "project-1", deps });
      throw new Error("expected the run to fail");
    } catch (error) {
      const failure = error as AnalysisFailedError;
      expect(failure).toBeInstanceOf(AnalysisFailedError);
      expect(failure.stage).toBe("comparison");
      expect(failure.runId).toBe("run-1");
      expect(failure.message).toContain("comparison exploded");
    }
  });

  it("does not persist partial results from a failed run", async () => {
    // Persistence happens once, after every stage has produced its output, so a
    // failed run leaves no half-written graph for M4 to render.
    const { analysisStore, deps, ownerId } = harness({ overrides: { "risk.draft": new Error("boom") } });

    await runAnalysis({ ownerId, projectId: "project-1", deps }).catch(() => undefined);

    expect(analysisStore.writes).toHaveLength(0);
  });

  it("still reports the original error when the failure cannot be persisted", async () => {
    // A store that is itself broken must not replace the real error with its own.
    const { deps, ownerId } = harness({
      failThrows: true,
      overrides: { "risk.draft": new Error("risk model exploded") },
    });

    await expect(runAnalysis({ ownerId, projectId: "project-1", deps })).rejects.toThrow(
      /risk model exploded/,
    );
  });

  it("marks a mid-flight failure before the join stage runs", async () => {
    const { runStore, model: _model, deps, ownerId } = harness({
      overrides: { "architecture.draft": new Error("architecture exploded") },
    });

    await runAnalysis({ ownerId, projectId: "project-1", deps }).catch(() => undefined);

    const steps = runStore.transitions.map((transition) => transition.step);
    expect(steps).toContain("architecture");
    expect(steps).not.toContain("comparison");
    expect(runStore.transitions.at(-1)?.status).toBe("failed");
  });
});

describe("executeAnalysisRun", () => {
  it("can be run separately from creation, which is what keeps the request short", async () => {
    const { runStore, deps, ownerId } = harness();
    const { runId } = await createAnalysisRun({ ownerId, projectId: "project-1", deps });

    // The row exists and is pending while the caller returns to the browser.
    expect((await runStore.store.getRun(ownerId, runId))?.status).toBe("pending");

    const result = await executeAnalysisRun({ runId, projectId: "project-1", deps });
    expect(result.runId).toBe(runId);
    expect((await runStore.store.getRun(ownerId, runId))?.status).toBe("complete");
  });
});
