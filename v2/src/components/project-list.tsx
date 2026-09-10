import { deleteProjectAction } from "@/app/actions/projects";
import { startAnalysisAction } from "@/app/actions/analysis";
import type { RunRecord } from "@/lib/agents/run";
import type { ProjectSummary } from "@/lib/projects/repository";

/**
 * The project list, with the analysis trigger and the latest run's state.
 *
 * Run state is rendered from the database, not from anything held in this page's
 * memory — which is what makes it survive a reload, a second tab, or the page
 * being re-rendered while a run is in flight. It also means the three run states
 * are visible as three different things:
 *
 *  - `pending` — created, not started (or the process died before starting it)
 *  - `running` — in progress, showing which stage was reached
 *  - `complete` / `failed` — finished, with the failing stage on failure
 *
 * Deliberately plain forms rather than a client component: starting and deleting
 * are rare, and making them real page-level interactions means they work without
 * JavaScript and need no client state to keep in sync.
 */

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

const RUN_TONE: Record<RunRecord["status"], string> = {
  pending: "text-[var(--muted)]",
  running: "text-[var(--accent)]",
  complete: "text-[var(--risk-low)]",
  failed: "text-[var(--risk-critical)]",
};

function RunStatus({ run }: { run: RunRecord }) {
  const label =
    run.status === "running" || run.status === "pending"
      ? `${run.status} · ${run.step}`
      : run.status === "complete"
        ? "complete"
        : `failed in ${run.step}`;

  return (
    <p className="mt-1 text-xs">
      <span className={RUN_TONE[run.status]}>analysis: {label}</span>
      <span className="text-[var(--muted)]"> · {formatDate(run.createdAt)}</span>
      {run.status === "failed" && run.error && (
        // Truncated for the list; the full text is in the run record and the
        // server log, so nothing is lost, but a wall of stack trace in a list row
        // would bury the other projects.
        <span className="block text-[var(--risk-critical)]">{run.error.slice(0, 200)}</span>
      )}
    </p>
  );
}

export function ProjectList({
  projects,
  runs,
}: {
  projects: ProjectSummary[];
  runs: Map<string, RunRecord>;
}) {
  if (projects.length === 0) {
    return (
      <section className="rounded-lg border border-dashed border-[var(--border)] p-5">
        <h2 className="text-base font-medium">No projects yet</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Upload a codebase above to start an analysis. Each project is visible only to this browser
          session.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <h2 className="border-b border-[var(--border)] px-5 py-3 text-sm font-semibold tracking-wide text-[var(--muted)] uppercase">
        Your projects
      </h2>
      <ul>
        {projects.map((project) => {
          const run = runs.get(project.id);
          return (
            <li
              key={project.id}
              className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{project.name}</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  {project.fileCount} files · {project.chunkCount} chunks · {project.sourceType} ·{" "}
                  {formatDate(project.createdAt)}
                </p>
                {run ? <RunStatus run={run} /> : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <form action={startAnalysisAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <button
                    type="submit"
                    disabled={run?.status === "running" || run?.status === "pending"}
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                  >
                    {run?.status === "running" || run?.status === "pending"
                      ? "Analysing…"
                      : "Run analysis"}
                  </button>
                </form>

                <form action={deleteProjectAction}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--risk-critical)] hover:text-[var(--risk-critical)]"
                  >
                    Delete
                  </button>
                </form>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
