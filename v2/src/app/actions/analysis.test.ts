import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The analysis action's scoping and its not-found result.
 *
 * Two things are being checked, and neither needs a database or a model: the action
 * must ask the run layer to start a run for *this session's* owner, and a project the
 * session cannot see must end in the not-found boundary rather than in a silent
 * success — the same result the delete action gives, so the two cannot be told apart.
 *
 * Everything the action reaches for is mocked, including the run layer that owns the
 * ownership check (`run.ts` is where `ProjectNotFoundError` is actually raised, and its
 * behaviour is covered by `run.test.ts` against the real implementation).
 */

const { notFound, revalidatePath, createAnalysisRun, executeAnalysisRun, ProjectNotFoundError, ensureOwnerId } =
  vi.hoisted(() => {
    class MockProjectNotFoundError extends Error {
      constructor(projectId: string) {
        super(`no project ${projectId}`);
        this.name = "ProjectNotFoundError";
      }
    }

    return {
      notFound: vi.fn(() => {
        throw new Error("NEXT_NOT_FOUND");
      }),
      revalidatePath: vi.fn(),
      createAnalysisRun: vi.fn(),
      executeAnalysisRun: vi.fn(),
      ProjectNotFoundError: MockProjectNotFoundError,
      ensureOwnerId: vi.fn(),
    };
  });

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/db/client", () => ({ hasDatabaseConfig: () => true }));
vi.mock("@/lib/session", () => ({ ensureOwnerId }));
vi.mock("@/lib/agents/wiring", () => ({ createAnalysisDeps: () => ({}) }));
vi.mock("@/lib/agents/run", () => ({
  ProjectNotFoundError,
  createAnalysisRun,
  executeAnalysisRun,
}));

function form(projectId: string | null): FormData {
  const data = new FormData();
  if (projectId !== null) data.set("projectId", projectId);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureOwnerId.mockResolvedValue("owner-1");
});

describe("startAnalysisAction", () => {
  it("queues a run for the session's own project and re-renders the page", async () => {
    createAnalysisRun.mockResolvedValue({ runId: "run-1", project: { id: "project-1", name: "legacy.zip" } });
    const { startAnalysisAction } = await import("./analysis");

    await startAnalysisAction(form("project-1"));

    expect(createAnalysisRun).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "owner-1", projectId: "project-1" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("gives not-found when the project is not visible to this session", async () => {
    createAnalysisRun.mockRejectedValue(new ProjectNotFoundError("someone-elses-project"));
    const { startAnalysisAction } = await import("./analysis");

    await expect(startAnalysisAction(form("someone-elses-project"))).rejects.toThrow("NEXT_NOT_FOUND");

    // Nothing was queued and nothing is revalidated: the refusal is before any write.
    expect(executeAnalysisRun).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does nothing at all for a submission with no project id", async () => {
    const { startAnalysisAction } = await import("./analysis");

    await startAnalysisAction(form(null));

    expect(createAnalysisRun).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
