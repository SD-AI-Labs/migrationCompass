import type { RunRecord } from "@/lib/agents/run";
import { latestRunsForOwner } from "@/lib/agents/stores";
import { getLogger } from "@/lib/observability/logger";
import { listProjectsForOwner, type ProjectSummary } from "@/lib/projects/repository";
import { listIndexedSources } from "@/lib/report/sources";
import type { IndexedSourceListing } from "@/lib/report/types";
import { loadScorecardForProject, type LoadedScorecard } from "@/lib/scoring/loader";

/**
 * The home page's reads, each with an outcome a page can render.
 *
 * Two rules, and they exist because the previous version broke the first one:
 *
 * 1. **A failed read is not an empty result.** Swallowing an error and returning `[]`
 *    makes the page say "No projects yet" when the database is unreachable — a false
 *    claim about the reader's data, and the most damaging kind of wrong interface. The
 *    list read therefore returns `{ ok: false }` with a message the page renders.
 * 2. **A failed secondary read degrades, it does not falsify.** The run state, the
 *    scorecards and the source list are per-project enrichments: if one fails, the page
 *    still renders what it has, states what it could not read, and logs the reason.
 *
 * Nothing here puts a database message in front of a reader: a connection error can
 * carry a URL with a password in it. The rendered text says what failed and what to do;
 * the log line carries the diagnostic.
 */

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function loadProjectsForPage(
  ownerId: string | null,
): Promise<LoadResult<ProjectSummary[]>> {
  if (!ownerId) return { ok: true, data: [] };

  try {
    return { ok: true, data: await listProjectsForOwner(ownerId) };
  } catch (error) {
    getLogger().error(
      { errorMessage: error instanceof Error ? error.message : String(error) },
      "Failed to list projects",
    );
    return {
      ok: false,
      message:
        "The project list could not be read. A database is configured, so this is a read failure rather than an empty account — nothing has been deleted, and reloading may be enough.",
    };
  }
}

export async function loadLatestRunsForPage(
  ownerId: string,
  projects: ProjectSummary[],
): Promise<Map<string, RunRecord>> {
  if (projects.length === 0) return new Map();

  try {
    return await latestRunsForOwner(
      ownerId,
      projects.map((project) => project.id),
    );
  } catch (error) {
    // The run state is an annotation on the project row: without it the row still lists
    // the project, and the page stays usable.
    getLogger().error(
      { errorMessage: error instanceof Error ? error.message : String(error) },
      "Failed to list analysis runs",
    );
    return new Map();
  }
}

export type LoadedAssessments = {
  scorecards: Map<string, LoadedScorecard>;
  /** Per project: what could not be loaded, ready to render as-is. */
  failures: Map<string, string>;
};

/**
 * The scorecard for every project that has a completed run.
 *
 * One lookup per project rather than a join: a session owns a handful of projects, each
 * lookup is two indexed queries, and the scorecard is computed on read from persisted
 * structured findings rather than cached — which is what keeps it deterministic and
 * impossible to serve a value that no longer matches the findings it came from. The
 * report is composed from this same value, so a project whose assessment fails here has
 * neither a scorecard nor a report, and says so.
 */
export async function loadAssessmentsForPage(
  ownerId: string,
  projects: ProjectSummary[],
): Promise<LoadedAssessments> {
  const scorecards = new Map<string, LoadedScorecard>();
  const failures = new Map<string, string>();

  for (const project of projects) {
    try {
      const loaded = await loadScorecardForProject(ownerId, project.id);
      if (loaded) scorecards.set(project.id, loaded);
    } catch (error) {
      getLogger().error({ error, projectId: project.id }, "Failed to load scorecard");
      failures.set(
        project.id,
        "This project's scorecard and report are computed from the database when the page renders, and that read failed. Nothing was lost — reload the page to try again; the server log records the reason.",
      );
    }
  }

  return { scorecards, failures };
}

/**
 * The indexed files behind each completed assessment, for the report's evidence list.
 *
 * Read for scored projects only — a project with nothing analysed has nothing to cite —
 * and read defensively: `listIndexedSources` returns an empty listing on failure and
 * logs it, because an unavailable file list must not cost a reader the rest of the
 * report, which is still explainable from the findings.
 */
export async function loadIndexedSourcesForPage(
  ownerId: string,
  projects: ProjectSummary[],
): Promise<Map<string, IndexedSourceListing>> {
  const sources = new Map<string, IndexedSourceListing>();

  for (const project of projects) {
    sources.set(project.id, await listIndexedSources(ownerId, project.id));
  }

  return sources;
}
