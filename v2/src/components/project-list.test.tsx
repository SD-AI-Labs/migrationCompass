// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunRecord } from "@/lib/agents/run";
import type { ProjectSummary } from "@/lib/projects/repository";

import { ProjectList } from "./project-list";

/** Built outside JSX: `new Map([[a, b]])` inline in an attribute is a parser trap. */
const noRuns = () => new Map<string, RunRecord>();
const withRun = (run: RunRecord = RUN) => new Map<string, RunRecord>([[PROJECT.id, run]]);

/**
 * The project list's row hierarchy.
 *
 * The row is the unit of this page: name, metadata, analysis state and actions on
 * one line, with the results opening underneath. These tests pin the presentation
 * decisions that make a list of projects scannable and keep the destructive control
 * in its place:
 *
 *  - a project that has never run says so, rather than showing an empty status;
 *  - `Delete` is a ghost control whose accessible name carries the project, while
 *    `Run analysis` keeps the secondary-button treatment;
 *  - a failed assessment read is stated on the row, and the row still works.
 *
 * The heavy children are mocked: the dependency canvas (React Flow needs a real
 * layout engine) and nothing else — the scorecard, report and progress components
 * are the ones a row is made of.
 */

vi.mock("@/components/dependency-graph", () => ({
  DependencyGraph: () => <div data-testid="dependency-graph" />,
}));

// The progress component asks the router to re-render when a watched run finishes;
// there is no app router in jsdom, and the polling behaviour itself is covered by
// `analysis-progress.test.tsx`.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(cleanup);

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "legacy-billing.zip",
  sourceType: "upload",
  fileCount: 12,
  chunkCount: 340,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

const RUN: RunRecord = {
  id: "run-1",
  projectId: "project-1",
  ownerId: "owner-1",
  status: "complete",
  step: "done",
  error: null,
  createdAt: new Date("2026-01-02T03:10:00.000Z"),
  completedAt: new Date("2026-01-02T03:14:00.000Z"),
  outputs: { discovery: null, architecture: null, risk: null, comparison: null },
};

describe("project rows", () => {
  it("says a project has not been analysed rather than leaving the state blank", () => {
    render(<ProjectList projects={[PROJECT]} runs={noRuns()} />);

    expect(screen.getByText("legacy-billing.zip")).toBeTruthy();
    expect(screen.getByText("Not analysed")).toBeTruthy();
    expect(screen.getByText(/Run the analysis to produce a scorecard and report/)).toBeTruthy();
  });

  it("keeps the name, the metadata and the analysis state in that order", () => {
    render(<ProjectList projects={[PROJECT]} runs={withRun()} />);

    const row = screen.getByRole("listitem");
    const text = row.textContent ?? "";

    expect(text.indexOf("legacy-billing.zip")).toBeLessThan(text.indexOf("12 files"));
    expect(text.indexOf("12 files")).toBeLessThan(text.indexOf("analysis: complete"));
    expect(text).toContain("340 chunks");
    expect(text).toContain("upload");
  });

  it("offers the run as a secondary action and names the delete per project", () => {
    render(<ProjectList projects={[PROJECT]} runs={noRuns()} />);

    const run = screen.getByRole("button", { name: "Run analysis" });
    const remove = screen.getByRole("button", { name: "Delete project legacy-billing.zip" });

    // Consistent controls from the shared button vocabulary, and the destructive one
    // is not dressed as the primary action.
    expect(run.className).toContain("btn-secondary");
    expect(remove.className).toContain("btn-quiet-danger");
    expect(remove.className).not.toContain("btn-primary");
    // The visible label is the same on every row, so the name has to carry it.
    expect(remove.textContent).toBe("Delete");
  });

  it("states a failed assessment read on the row and leaves the row usable", () => {
    const failures = new Map<string, string>([
      [PROJECT.id, "The scorecard and report are computed on read, and that read failed."],
    ]);

    render(<ProjectList projects={[PROJECT]} runs={withRun()} failures={failures} />);

    expect(
      screen.getByRole("region", { name: "Assessment unavailable for legacy-billing.zip" }),
    ).toBeTruthy();
    expect(screen.getByText(/that read failed/)).toBeTruthy();
    // The row still works.
    expect(screen.getByRole("button", { name: "Run analysis" })).toBeTruthy();
  });

  it("explains a completed run that predates structured outputs", () => {
    const legacy: RunRecord = { ...RUN, id: "run-0" };
    render(<ProjectList projects={[PROJECT]} runs={withRun(legacy)} />);

    expect(screen.getByText(/completed before structured outputs were persisted/)).toBeTruthy();
  });
});

describe("empty and large lists", () => {
  it("explains the empty state, why it matters and what creates a project", () => {
    render(<ProjectList projects={[]} runs={noRuns()} />);

    const heading = screen.getByRole("heading", { name: "Projects" });
    expect(heading).toBeTruthy();
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.getByText(/visible only to this browser session/)).toBeTruthy();
    // Not a giant empty box: one note, and nothing that looks like a result.
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("counts the projects it is showing", () => {
    const second = { ...PROJECT, id: "project-2", name: "other.zip" };
    render(<ProjectList projects={[PROJECT, second]} runs={noRuns()} />);

    expect(screen.getByText("2 projects")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
