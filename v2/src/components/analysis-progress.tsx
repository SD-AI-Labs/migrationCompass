"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  STAGE_LABELS,
  isActiveStatus,
  isTerminalStatus,
  labelForStep,
  stageChecklist,
  type AnalysisProgress as AnalysisProgressState,
  type StageState,
} from "@/lib/agents/progress";

/**
 * The live state of one analysis run.
 *
 * Why this exists: a run takes minutes, and the page it was started from is a
 * server component. That render is a snapshot — the server action that starts a
 * run *does* refresh it, but it does so while the run is still `pending`, and
 * nothing re-renders afterwards. The result was a page that said "Analysing…"
 * forever while the run row had long since been marked `complete`, and a restart
 * (any fresh request) was the only thing that showed the scores.
 *
 * So the browser watches the run itself: it polls the owner-scoped status of the
 * project, and when the persisted run reaches a terminal state it asks the router
 * to re-render the page — which is now the same page the user would have got after
 * a restart, but without one.
 *
 * Two rules it holds to:
 *
 * 1. **Nothing is faked.** The stage shown is read from the run row. There is no
 *    timer, no percentage and no interpolated stage: a stage label that the
 *    database does not hold is not displayed.
 * 2. **A failed poll is not a failed run.** Only a persisted terminal state ends
 *    the watch; a read that errors (or finds no run) leaves the last known state
 *    on screen and tries again, because a transient database error must not
 *    strand — or misinform — a reader.
 *
 * The poll function is injected rather than imported so this behaviour is testable
 * without a database; the server component passes the real Server Action.
 */

/** Long enough to be cheap, short enough that a finished run appears promptly. */
export const ANALYSIS_POLL_INTERVAL_MS = 4000;

const STAGE_MARKERS: Record<StageState["state"], string> = {
  done: "✓",
  current: "◐",
  pending: "·",
  failed: "✕",
};

const STAGE_TONES: Record<StageState["state"], string> = {
  done: "text-[var(--risk-low)]",
  current: "text-[var(--accent)]",
  pending: "text-[var(--muted)]",
  failed: "text-[var(--risk-critical)]",
};

const STAGE_WORDS: Record<StageState["state"], string> = {
  done: "done",
  current: "in progress",
  pending: "not started",
  failed: "failed",
};

const RUN_DOT: Record<AnalysisProgressState["status"], string> = {
  none: "bg-[var(--risk-unknown)]",
  pending: "bg-[var(--muted)]",
  running: "bg-[var(--accent)]",
  complete: "bg-[var(--risk-low)]",
  failed: "bg-[var(--risk-critical)]",
};

/** Statuses where the run is still moving, so the dot is allowed a slow pulse. */
function isMoving(status: AnalysisProgressState["status"]): boolean {
  return status === "running" || status === "pending";
}

const RUN_TEXT: Record<AnalysisProgressState["status"], string> = {
  none: "text-[var(--muted)]",
  pending: "text-[var(--muted)]",
  running: "text-[var(--accent)]",
  complete: "text-[var(--risk-low)]",
  failed: "text-[var(--risk-critical)]",
};

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/** The one-line status: what a reader needs when there is no room for the stages. */
function describeStatus(progress: AnalysisProgressState): string {
  switch (progress.status) {
    case "pending":
      // A queued row carries the `discovery` step because the column is not
      // nullable, but nothing has started: the honest label is the queued one.
      return `${progress.status} · ${STAGE_LABELS.starting}`;
    case "running":
      return `${progress.status} · ${labelForStep(progress.step)}`;
    case "complete":
      return "complete";
    case "failed":
      return `failed during ${labelForStep(progress.step)}`;
    default:
      return "not started";
  }
}

/**
 * The prop is named `…Action` on purpose: Next.js's TypeScript plugin recognises a
 * Server Function crossing into a Client Component by that convention (or by the
 * name `action`), and flags any other function prop as one that cannot cross the
 * boundary.
 */
export function AnalysisProgress({
  projectId,
  initial,
  pollAction,
  intervalMs = ANALYSIS_POLL_INTERVAL_MS,
}: {
  projectId: string;
  /** The state the server rendered with — the same data the run row holds. */
  initial: AnalysisProgressState;
  /** The owner-scoped read, as a Server Action. */
  pollAction: (projectId: string) => Promise<AnalysisProgressState>;
  intervalMs?: number;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState<AnalysisProgressState>(initial);

  // The polling effect must not be re-created by a prop or context identity that
  // merely changed value — re-creating it re-arms the timer, and an effect that
  // re-arms a timer faster than it fires is a polling storm. The two things it calls
  // therefore come through refs, and its dependency list holds only values that
  // actually change the behaviour: the project, the cadence, the status.
  //
  // Assigned in effects rather than during render, which is where a ref write
  // belongs — and which keeps the render itself free of anything a re-render could
  // observe differently.
  const pollRef = useRef(pollAction);
  const routerRef = useRef(router);
  /** The run+status the immediate first check was made for. */
  const checkedRef = useRef<string | null>(null);

  useEffect(() => {
    pollRef.current = pollAction;
  }, [pollAction]);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // A new run (a different id) replaces what this component is watching; the state
  // is keyed to the run id so a re-render with the previous run's props cannot
  // resurrect a stale stage.
  const runKey = initial.runId ?? "";
  const [watchedRun, setWatchedRun] = useState(runKey);
  if (runKey !== watchedRun) {
    setWatchedRun(runKey);
    setProgress(initial);
  }

  const status = progress.status;
  const watchedRunId = progress.runId;

  useEffect(() => {
    if (!isActiveStatus(status)) return;

    let cancelled = false;
    let refreshed = false;

    const tick = async (): Promise<void> => {
      try {
        const next = await pollRef.current(projectId);
        if (cancelled) return;

        // Nothing readable (deleted project, or a read that failed): keep what is
        // on screen and ask again rather than claiming the run vanished.
        if (next.status === "none" || next.runId === null) return;

        setProgress(next);

        if (isTerminalStatus(next.status) && !refreshed) {
          // The persisted run is finished while this page still holds the older
          // render — re-render it from the server so the scorecard appears.
          refreshed = true;
          routerRef.current.refresh();
        }
      } catch {
        // Swallowed on purpose: the next tick is the retry.
      }
    };

    // Checked once per run and status rather than on every effect run: the first
    // check is what recovers a page rendered while the run was still in flight, and
    // repeating it per effect run would turn a re-created effect into a loop.
    const checkKey = `${watchedRunId ?? ""}:${status}`;
    if (checkedRef.current !== checkKey) {
      checkedRef.current = checkKey;
      void tick();
    }

    const timer = setInterval(() => void tick(), intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, intervalMs, status, watchedRunId]);

  const timestamp = formatTimestamp(progress.finishedAt ?? progress.startedAt);
  // The checklist earns its space while a run is unfinished or failed — that is
  // where "which stage is it in" and "which stage did it die in" are the questions
  // being asked. A completed run is one word, and the stages behind it add nothing.
  const showChecklist = progress.status !== "complete" && progress.status !== "none";

  return (
    <div className="mt-1.5 text-xs">
      {/* A live region rather than a static line: the status changes on its own, and
          a screen reader should be told so without stealing focus. `role="status"`
          carries that politeness implicitly.

          The dot is decoration and the words carry the state — and the whole line
          keeps the exact wording the tests and the logs use ("analysis: running ·
          Risk analysis"), so what a reader sees is what the server recorded. */}
      <p role="status" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          aria-hidden
          className={`inline-block size-1.5 shrink-0 self-center rounded-full ${RUN_DOT[progress.status]} ${
            isMoving(progress.status) ? "animate-pulse" : ""
          }`}
        />
        <span className="text-[var(--foreground)]">
          analysis: <span className={RUN_TEXT[progress.status]}>{describeStatus(progress)}</span>
        </span>
        {timestamp && <span className="meta">· {timestamp}</span>}
      </p>

      {showChecklist && (
        <ol
          aria-label="Analysis stages"
          className="mt-2 flex flex-wrap items-baseline gap-x-3.5 gap-y-1"
        >
          {stageChecklist(progress).map((stage) => (
            <li key={stage.id} className="flex items-baseline gap-1.5 text-[11px]">
              <span aria-hidden className={STAGE_TONES[stage.state]}>
                {STAGE_MARKERS[stage.state]}
              </span>
              <span
                className={`${STAGE_TONES[stage.state]} ${
                  stage.state === "current" ? "font-medium" : ""
                }`}
              >
                {stage.label}
              </span>
              <span className="sr-only">{STAGE_WORDS[stage.state]}</span>
            </li>
          ))}
        </ol>
      )}

      {progress.status === "failed" && progress.error && (
        // `role="alert"` rather than `status`: this appears mid-session when a run
        // finishes badly, and a failure the reader did not ask to go looking for is
        // worth announcing. Truncated here; the full text is in the run record and the
        // server log.
        <div role="alert" className="note mt-2 border-l-2 border-l-[var(--risk-critical)] border-solid">
          <p className="text-[12px] text-[var(--risk-critical)]">{progress.error.slice(0, 200)}</p>
          <p className="mt-1">
            The analysis stopped at the stage above; its record is kept. Running the analysis again
            starts a new run — the previous one stays in the database.
          </p>
        </div>
      )}
    </div>
  );
}
