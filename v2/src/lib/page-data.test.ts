import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSummary } from "@/lib/projects/repository";

/**
 * The page's reads, driven with mocked repositories.
 *
 * The behaviour under test is the difference between "nothing is there" and "I could
 * not read it": the first version of these loaders returned an empty list on failure,
 * which made the page announce "No projects yet" while the database was unreachable.
 * The tests below assert the outcome object, the rendered-ready message, and — most
 * importantly — that a database error's own text never reaches a reader, because a
 * connection error can carry a URL with a password in it.
 */

const { listProjectsForOwner, latestRunsForOwner, loadScorecardForProject, listIndexedSources } =
  vi.hoisted(() => ({
    listProjectsForOwner: vi.fn(),
    latestRunsForOwner: vi.fn(),
    loadScorecardForProject: vi.fn(),
    listIndexedSources: vi.fn(),
  }));

vi.mock("@/lib/projects/repository", () => ({ listProjectsForOwner }));
vi.mock("@/lib/agents/stores", () => ({ latestRunsForOwner }));
vi.mock("@/lib/scoring/loader", () => ({ loadScorecardForProject }));
vi.mock("@/lib/report/sources", () => ({ listIndexedSources }));

async function pageData() {
  return import("./page-data");
}

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "legacy.zip",
  sourceType: "upload",
  fileCount: 3,
  chunkCount: 9,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

/** A database error of the shape that must never be shown: it carries the URL. */
const LEAKY_ERROR = new Error(
  "connect ECONNREFUSED postgres://compass:sup3r-secret@localhost:5432/compass",
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadProjectsForPage", () => {
  it("does not touch the database for a session with no owner id", async () => {
    const { loadProjectsForPage } = await pageData();

    expect(await loadProjectsForPage(null)).toEqual({ ok: true, data: [] });
    expect(listProjectsForOwner).not.toHaveBeenCalled();
  });

  it("returns the projects when the read succeeds", async () => {
    listProjectsForOwner.mockResolvedValue([PROJECT]);
    const { loadProjectsForPage } = await pageData();

    expect(await loadProjectsForPage("owner-1")).toEqual({ ok: true, data: [PROJECT] });
  });

  it("reports a failure as a failure, not as an empty list", async () => {
    listProjectsForOwner.mockRejectedValue(LEAKY_ERROR);
    const { loadProjectsForPage } = await pageData();

    const result = await loadProjectsForPage("owner-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("could not be read");
    expect(result.message).toContain("nothing has been deleted");
  });

  it("never puts the database's own message in front of a reader", async () => {
    listProjectsForOwner.mockRejectedValue(LEAKY_ERROR);
    const { loadProjectsForPage } = await pageData();

    const result = await loadProjectsForPage("owner-1");
    const rendered = JSON.stringify(result);

    expect(rendered).not.toContain("sup3r-secret");
    expect(rendered).not.toContain("ECONNREFUSED");
    expect(rendered).not.toContain("postgres://");
  });
});

describe("loadLatestRunsForPage", () => {
  it("returns nothing to fetch when there are no projects", async () => {
    const { loadLatestRunsForPage } = await pageData();

    expect((await loadLatestRunsForPage("owner-1", [])).size).toBe(0);
    expect(latestRunsForOwner).not.toHaveBeenCalled();
  });

  it("degrades to an empty map when the run state cannot be read", async () => {
    latestRunsForOwner.mockRejectedValue(LEAKY_ERROR);
    const { loadLatestRunsForPage } = await pageData();

    // The run state is an annotation on the row: without it the project list still
    // works, so a failure here must not fail the page.
    expect((await loadLatestRunsForPage("owner-1", [PROJECT])).size).toBe(0);
  });
});

describe("loadAssessmentsForPage", () => {
  it("keeps the assessments it could read and names the ones it could not", async () => {
    const loaded = { run: { id: "run-1" } };
    loadScorecardForProject.mockImplementation(async (_owner: string, projectId: string) => {
      if (projectId === "project-1") return loaded;
      throw LEAKY_ERROR;
    });

    const { loadAssessmentsForPage } = await pageData();
    const second = { ...PROJECT, id: "project-2", name: "other.zip" };
    const { scorecards, failures } = await loadAssessmentsForPage("owner-1", [PROJECT, second]);

    expect(scorecards.get("project-1")).toBe(loaded);
    expect(failures.has("project-2")).toBe(true);
    expect(failures.get("project-2")).toContain("that read failed");
    expect(JSON.stringify([...failures.values()])).not.toContain("sup3r-secret");
  });

  it("treats a project with no completed run as neither loaded nor failed", async () => {
    loadScorecardForProject.mockResolvedValue(null);
    const { loadAssessmentsForPage } = await pageData();

    const { scorecards, failures } = await loadAssessmentsForPage("owner-1", [PROJECT]);

    expect(scorecards.size).toBe(0);
    expect(failures.size).toBe(0);
  });
});

describe("loadIndexedSourcesForPage", () => {
  it("keys the listings by project and asks for each one with the session's owner", async () => {
    const listing = { sources: [{ source: "src/A.java", documentType: "source", chunks: 1 }], total: 1 };
    listIndexedSources.mockResolvedValue(listing);

    const { loadIndexedSourcesForPage } = await pageData();
    const second = { ...PROJECT, id: "project-2" };
    const sources = await loadIndexedSourcesForPage("owner-1", [PROJECT, second]);

    expect(sources.get("project-1")).toBe(listing);
    expect(sources.get("project-2")).toBe(listing);
    expect(listIndexedSources).toHaveBeenCalledWith("owner-1", "project-1");
    expect(listIndexedSources).toHaveBeenCalledWith("owner-1", "project-2");
  });
});
