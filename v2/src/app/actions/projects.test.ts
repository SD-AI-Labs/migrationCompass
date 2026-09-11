import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The delete action's owner scoping and its not-found result.
 *
 * The scoping rule is the one that matters most: the repository call must carry the
 * session's owner id, so a guessed project id cannot delete someone else's work. The
 * second rule is what the reader sees: a project that cannot be seen and a project that
 * does not exist both end in the not-found boundary, because telling them apart would
 * confirm that another session's id exists.
 *
 * `next/navigation`, the repository and the session are mocked — this is the action's
 * own logic, not the database's behaviour (which `repository.integration.test.ts`
 * covers against live Postgres).
 */

const { notFound, revalidatePath, deleteProjectForOwner, getOwnerId } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  revalidatePath: vi.fn(),
  deleteProjectForOwner: vi.fn(),
  getOwnerId: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/projects/repository", () => ({ deleteProjectForOwner }));
vi.mock("@/lib/session", () => ({ getOwnerId }));

function form(projectId: string | null): FormData {
  const data = new FormData();
  if (projectId !== null) data.set("projectId", projectId);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  getOwnerId.mockResolvedValue("owner-1");
});

describe("deleteProjectAction", () => {
  it("scopes the delete to the session's owner and re-renders the page", async () => {
    deleteProjectForOwner.mockResolvedValue(true);
    const { deleteProjectAction } = await import("./projects");

    await deleteProjectAction(form("project-1"));

    expect(deleteProjectForOwner).toHaveBeenCalledWith("owner-1", "project-1");
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("gives not-found when the project is missing or belongs to another session", async () => {
    // The repository reports "nothing deleted" for both cases; the action must not
    // distinguish them, and must not pretend the delete succeeded.
    deleteProjectForOwner.mockResolvedValue(false);
    const { deleteProjectAction } = await import("./projects");

    await expect(deleteProjectAction(form("someone-elses-project"))).rejects.toThrow("NEXT_NOT_FOUND");

    expect(deleteProjectForOwner).toHaveBeenCalledWith("owner-1", "someone-elses-project");
    // Nothing changed, so nothing is revalidated.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("gives not-found rather than deleting when there is no session", async () => {
    getOwnerId.mockResolvedValue(null);
    const { deleteProjectAction } = await import("./projects");

    await expect(deleteProjectAction(form("project-1"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(deleteProjectForOwner).not.toHaveBeenCalled();
  });

  it("does nothing at all for a submission with no project id", async () => {
    const { deleteProjectAction } = await import("./projects");

    await deleteProjectAction(form(null));

    // A malformed submission is not a missing resource: no lookup, no not-found, no
    // database write.
    expect(deleteProjectForOwner).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ignores an empty project id", async () => {
    const { deleteProjectAction } = await import("./projects");

    await deleteProjectAction(form(""));

    expect(deleteProjectForOwner).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });
});
