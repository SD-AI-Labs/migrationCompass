// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  absentProgress,
  toAnalysisProgress,
  type AnalysisProgress as AnalysisProgressState,
} from "@/lib/agents/progress";
import type { RunStatus, RunStep } from "@/lib/agents/run";

import { AnalysisProgress } from "./analysis-progress";

/**
 * The behaviour that made a browser restart necessary: a run finishes on the server
 * while the page still holds a render that says "running". These tests use the
 * injected poll function rather than a database, so they assert the client's
 * behaviour directly — what it shows, when it asks again, and when it stops.
 */

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function progress(
  status: RunStatus,
  step: RunStep,
  overrides: { error?: string | null; completedAt?: Date | null; runId?: string } = {},
): AnalysisProgressState {
  return toAnalysisProgress({
    id: overrides.runId ?? "run-1",
    status,
    step,
    error: overrides.error ?? null,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    completedAt: overrides.completedAt ?? null,
  });
}

/** Lets the immediate first poll and any pending timers settle inside `act`. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderProgress(
  initial: AnalysisProgressState,
  poll: (projectId: string) => Promise<AnalysisProgressState>,
  intervalMs = 1000,
) {
  return render(
    <AnalysisProgress
      projectId="project-1"
      initial={initial}
      pollAction={poll}
      intervalMs={intervalMs}
    />,
  );
}

const statusText = (): string => screen.getByRole("status").textContent ?? "";

describe("running state", () => {
  it("shows the persisted stage and which stages are behind it", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => progress("running", "risk"));
    renderProgress(progress("running", "risk"), poll);

    expect(statusText()).toContain("analysis: running · Risk analysis");

    const stages = screen.getByRole("list", { name: "Analysis stages" });
    const rows = Array.from(stages.querySelectorAll("li")).map((row) => row.textContent ?? "");

    expect(rows.some((row) => row.includes("Discovery analysis") && row.includes("done"))).toBe(true);
    expect(rows.some((row) => row.includes("Risk analysis") && row.includes("in progress"))).toBe(true);
    // A concurrent branch is not reported as finished while the run is in the other one.
    expect(rows.some((row) => row.includes("Architecture analysis") && row.includes("done"))).toBe(false);
    expect(rows.some((row) => row.includes("Finalizing results") && row.includes("not started"))).toBe(true);

    await settle();
  });

  it("keeps polling while the run is unfinished", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => progress("running", "architecture"));
    renderProgress(progress("running", "discovery"), poll, 1000);

    await settle();
    expect(poll).toHaveBeenCalledTimes(1);

    await settle(3000);
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the stages progressing as the persisted step advances", async () => {
    vi.useFakeTimers();
    let step: RunStep = "architecture";
    const poll = vi.fn(async () => progress("running", step));
    renderProgress(progress("running", "discovery"), poll, 1000);

    await settle();
    expect(statusText()).toContain("analysis: running · Architecture analysis");

    step = "comparison";
    await settle(1000);

    const rows = screen
      .getByRole("list", { name: "Analysis stages" })
      .querySelectorAll("li");
    const text = Array.from(rows).map((row) => row.textContent ?? "");
    // Reaching the join stage proves both concurrent branches finished.
    expect(text.some((row) => row.includes("Architecture analysis") && row.includes("done"))).toBe(true);
    expect(text.some((row) => row.includes("Risk analysis") && row.includes("done"))).toBe(true);
    expect(text.some((row) => row.includes("Comparison analysis") && row.includes("in progress"))).toBe(true);
  });
});

describe("stale running UI recovering from a completed run", () => {
  it("re-renders the page when the persisted run has already finished", async () => {
    vi.useFakeTimers();
    // The page was rendered while the run was in flight; by the time the browser
    // asks, the run row is complete.
    const poll = vi.fn(async () => progress("complete", "done", { completedAt: new Date() }));
    renderProgress(progress("running", "comparison"), poll);

    await settle();

    expect(statusText()).toContain("analysis: complete");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops asking once the run is finished", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => progress("complete", "done"));
    renderProgress(progress("running", "comparison"), poll, 1000);

    await settle();
    const callsWhenFinished = poll.mock.calls.length;

    await settle(5000);
    expect(poll.mock.calls.length).toBe(callsWhenFinished);
    // One refresh, not one per tick.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers from a failed poll without stranding the reader", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const poll = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("database unreachable");
      return progress("complete", "done");
    });

    renderProgress(progress("running", "risk"), poll, 1000);

    await settle();
    // The failed read left the last known stage on screen and did not refresh.
    expect(statusText()).toContain("analysis: running · Risk analysis");
    expect(refresh).not.toHaveBeenCalled();

    await settle(1000);
    expect(statusText()).toContain("analysis: complete");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not treat an unreadable run as a finished one", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => absentProgress());

    renderProgress(progress("running", "risk"), poll, 1000);

    await settle(2000);

    // Nothing readable is not "complete": the last known state stays on screen, and
    // the watcher is still watching.
    expect(statusText()).toContain("analysis: running · Risk analysis");
    expect(refresh).not.toHaveBeenCalled();
    expect(poll.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("completed state", () => {
  it("shows completion and does not poll a finished run", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => progress("complete", "done"));
    renderProgress(progress("complete", "done"), poll);

    await settle(5000);

    expect(statusText()).toContain("analysis: complete");
    expect(poll).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("failed state", () => {
  it("names the stage it failed in and shows the message", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => progress("failed", "risk"));

    renderProgress(
      progress("failed", "risk", { error: "risk model exploded", completedAt: new Date() }),
      poll,
    );

    expect(statusText()).toContain("analysis: failed during Risk analysis");
    expect(screen.getByText("risk model exploded")).toBeTruthy();

    // A terminal state is not polled, and needs no refresh: the page already shows it.
    await settle(5000);
    expect(poll).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks the failing stage as failed rather than leaving it looking in progress", () => {
    vi.useFakeTimers();
    renderProgress(
      progress("failed", "risk", { error: "boom", completedAt: new Date() }),
      async () => progress("failed", "risk"),
    );

    const rows = Array.from(
      screen.getByRole("list", { name: "Analysis stages" }).querySelectorAll("li"),
    ).map((row) => row.textContent ?? "");

    expect(rows.some((row) => row.includes("Risk analysis") && row.includes("failed"))).toBe(true);
    expect(rows.some((row) => row.includes("Comparison analysis") && row.includes("not started"))).toBe(true);
  });
});

describe("a new run", () => {
  it("resets the progress it is watching when the run id changes", async () => {
    vi.useFakeTimers();
    // Never resolves: the point is the state the component derives from its props.
    const never = vi.fn(() => new Promise<AnalysisProgressState>(() => {}));

    const view = renderProgress(progress("complete", "done"), never);
    await settle();
    expect(statusText()).toContain("analysis: complete");

    view.rerender(
      <AnalysisProgress
        projectId="project-1"
        initial={progress("pending", "discovery", { runId: "run-2" })}
        pollAction={never}
        intervalMs={1000}
      />,
    );

    expect(statusText()).toContain("analysis: pending · Starting analysis");
    expect(refresh).not.toHaveBeenCalled();
  });
});
