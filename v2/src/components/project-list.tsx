import { deleteProjectAction } from "@/app/actions/projects";
import { startAnalysisAction } from "@/app/actions/analysis";
import { readAnalysisProgressAction } from "@/app/actions/analysis-status";
import { AnalysisProgress } from "@/components/analysis-progress";
import { AnalysisReport } from "@/components/analysis-report";
import { DependencyGraph } from "@/components/dependency-graph";
import { DependencyList } from "@/components/dependency-list";
import { ErrorNotice } from "@/components/error-notice";
import { RefineEstimatesForm } from "@/components/refine-form";
import { Scorecard } from "@/components/scorecard";
import { toAnalysisProgress } from "@/lib/agents/progress";
import type { RunRecord } from "@/lib/agents/run";
import { buildDependencyGraph } from "@/lib/graph/build-graph";
import type { ProjectSummary } from "@/lib/projects/repository";
import { buildAnalysisReport } from "@/lib/report/builder";
import type { IndexedSourceListing } from "@/lib/report/types";
import type { LoadedScorecard } from "@/lib/scoring/loader";

/**
 * The project list, with the analysis trigger, the latest run's state, and — once
 * a run has completed — the scorecard and dependency graph for that run.
 *
 * Run state is rendered from the database, not from anything held in this page's
 * memory — which is what makes it survive a reload, a second tab, or the page
 * being re-rendered while a run is in flight. It also means the run states are
 * visible as different things:
 *
 *  - `pending` — created, not started (or the process died before starting it)
 *  - `running` — in progress, showing which stage was reached and which are behind it
 *  - `complete` / `failed` — finished, with the failing stage on failure
 *
 * While a run is unfinished the state is handed to `<AnalysisProgress>`, which
 * polls the persisted run and re-renders this page when it finishes. That is the
 * piece that makes "scores appear on their own" true: this component graph is a
 * server render, and without a watcher on the client the only thing that could
 * ever show a completed run was a fresh request.
 *
 * The assessment is a `<details>` rather than a route of its own: the plan's
 * progressive-disclosure rule is "expand in place, never navigate", and a
 * disclosure that costs a page load would be a destination by another name.
 *
 * Deliberately plain forms rather than a client component: starting and deleting
 * are rare, and making them real page-level interactions means they work without
 * JavaScript and need no client state to keep in sync.
 *
 * Presentation note: a project is one row of a list, not a box inside a box. The
 * header carries the hierarchy (name, metadata, state, actions) and the results
 * open underneath it behind a single hairline, so a list of ten projects reads as
 * ten rows rather than as ten bordered containers.
 */

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function RunStatus({ run }: { run: RunRecord }) {
  // The run's project id rather than its own: the status read is owner-scoped and
  // always answers for the project's *latest* run, which is the one this row shows.
  return (
    <AnalysisProgress
      projectId={run.projectId}
      initial={toAnalysisProgress(run)}
      pollAction={readAnalysisProgressAction}
    />
  );
}

function ProjectScorecard({
  loaded,
  project,
  sources,
}: {
  loaded: LoadedScorecard;
  project: ProjectSummary;
  /** The indexed files behind the assessment, for the report's evidence section. */
  sources: IndexedSourceListing;
}) {
  // Built here from the persisted findings and edges — the graph model is derived
  // data, so it is not stored and cannot drift from what was recorded. One build
  // feeds both the graph view and the report's architecture section, so the
  // coupling the report describes is the coupling the picture draws.
  const graph = buildDependencyGraph({
    services: loaded.input.findings,
    dependencies: loaded.input.dependencies,
  });

  // Composed on the server: pure functions over the persisted analysis, no model
  // call, and the client component receives a finished value.
  const report = buildAnalysisReport({ project, loaded, graph, sources });

  return (
    // Open by default: the scorecard is the headline artifact, and a headline behind
    // a click is not one. The per-score breakdowns inside stay collapsed, so the
    // card reads as five numbers and an evidence tag until a reader asks why.
    //
    // The summary is a label, not a heading: the three panels below it carry the
    // headings (Scorecard, Analysis Report, Dependency graph), and inserting one
    // above them would put an h4 in front of its own h3 children.
    <details open className="row-disclosure mt-3">
      <summary>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="eyebrow">Assessment</span>
          <span className="meta">scorecard · analysis report · dependency graph</span>
        </span>
        <span aria-hidden className="marker">
          ›
        </span>
      </summary>

      <div className="flex flex-col pt-2 pb-2">
        <Scorecard
          scorecard={loaded.scorecard}
          explanation={loaded.explanation}
          baseline={loaded.refinement.changed ? loaded.baseline : undefined}
          refinement={{
            changed: loaded.refinement.changed,
            description: loaded.refinement.description,
            reasons: loaded.refinement.adjustment.reasons,
            terms: loaded.refinement.adjustment.terms,
            parameters: loaded.refinement.parameters,
          }}
        />
        <AnalysisReport report={report} projectName={project.name} />
        <DependencyGraph model={graph} findings={loaded.input.findings} />
        {/* The same model the graph above draws, as text. React Flow is a canvas with
            no reading order, and its edge layer has a known rendering defect, so the
            topology must not be reachable only through it. */}
        <DependencyList model={graph} />
        <RefineEstimatesForm
          projectId={loaded.run.projectId}
          parameters={loaded.refinement.parametersInForce}
          storedFiles={loaded.refinement.operational.entries}
          isRefined={loaded.refinement.changed}
        />
      </div>
    </details>
  );
}

/** The state of a project that has never been analysed. */
function NoRunStatus() {
  return (
    <p className="meta mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
        <span aria-hidden className="inline-block size-1.5 rounded-full bg-[var(--risk-unknown)]" />
        Not analysed
      </span>
      <span>Run the analysis to produce a scorecard and report.</span>
    </p>
  );
}

export function ProjectList({
  projects,
  runs,
  scorecards = new Map(),
  sources = new Map(),
  failures = new Map(),
}: {
  projects: ProjectSummary[];
  runs: Map<string, RunRecord>;
  scorecards?: Map<string, LoadedScorecard>;
  /** Indexed source files per project, listed in the report's evidence section. */
  sources?: Map<string, IndexedSourceListing>;
  /** Projects whose scorecard/report read failed, and what to tell the reader. */
  failures?: Map<string, string>;
}) {
  if (projects.length === 0) {
    return (
      <section aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="eyebrow">
          Projects
        </h2>
        <div className="note measure mt-3">
          <p className="text-[13px] text-[var(--foreground)]">No projects yet</p>
          <p className="mt-1">
            A project is created by uploading a codebase. Each one is visible only to this browser
            session, and keeps its own runs, scorecard and report.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="projects-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="projects-heading" className="eyebrow">
          Projects
        </h2>
        <p className="meta">
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </p>
      </div>

      <ul className="panel-bare mt-3">
        {projects.map((project) => {
          const run = runs.get(project.id);
          const scorecard = scorecards.get(project.id);
          const failure = failures.get(project.id);
          const busy = run?.status === "running" || run?.status === "pending";

          return (
            <li
              key={project.id}
              className="border-b border-[var(--border-subtle)] px-5 py-4 first:rounded-t-[0.625rem] last:rounded-b-[0.625rem] last:border-b-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-medium">{project.name}</p>
                  <p className="meta mt-0.5">
                    {project.fileCount} files · {project.chunkCount} chunks · {project.sourceType} ·{" "}
                    {formatDate(project.createdAt)}
                  </p>
                  {run ? <RunStatus run={run} /> : <NoRunStatus />}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <form action={startAnalysisAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <button type="submit" disabled={busy} className="btn btn-secondary">
                      {busy ? "Analysing…" : "Run analysis"}
                    </button>
                  </form>

                  <form action={deleteProjectAction}>
                    <input type="hidden" name="projectId" value={project.id} />
                    <button
                      type="submit"
                      // The visible label is the same on every row; the accessible name
                      // carries the project so a screen-reader user knows which one a
                      // destructive control belongs to. Restrained on purpose: Delete
                      // must not compete with Run analysis for attention.
                      aria-label={`Delete project ${project.name}`}
                      className="btn btn-quiet-danger"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </div>

              {scorecard ? (
                <ProjectScorecard
                  loaded={scorecard}
                  project={project}
                  sources={sources.get(project.id) ?? { sources: [], total: 0 }}
                />
              ) : failure !== undefined ? (
                // A read that failed is not a project without an assessment: the row
                // still works (re-run, delete), and the reason is stated rather than
                // left as an unexplained blank.
                <div className="mt-3">
                  <ErrorNotice
                    title={`Assessment unavailable for ${project.name}`}
                    detail={failure}
                    action="Re-running the analysis would not recover this — the numbers were never lost."
                  />
                </div>
              ) : run?.status === "complete" ? (
                <p className="note mt-3">
                  This run completed before structured outputs were persisted, so there is no scorecard
                  or report to show. Run the analysis again to produce one.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
