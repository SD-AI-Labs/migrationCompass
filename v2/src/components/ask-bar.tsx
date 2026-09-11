"use client";

import { useEffect, useRef, useState } from "react";

import { onAskRequest } from "@/lib/ask-handoff";
import { drainSseEvents } from "@/lib/sse";

/**
 * The persistent ask bar.
 *
 * Present whenever there is a project, never a destination you navigate to —
 * which is the plan's Layer 4 rule. Three behaviours worth noting:
 *
 * - Citations render before the first answer token, because they arrive first.
 *   Showing the evidence while the answer streams is the whole reason the
 *   endpoint streams in two phases instead of one blob.
 * - The retrieved/used counts are displayed prominently ("8 of 41 chunks"),
 *   because an answer that does not say what it looked at invites the reader to
 *   assume it looked at everything.
 * - It is the single sink for `requestAsk()` handoffs from the report (and anywhere
 *   else): a handoff selects the project, prefills the question and takes focus, and
 *   the reader still presses Ask. One conversational surface, and the model call
 *   stays an explicit act.
 */

type Citation = { source: string; documentType: string; similarity: number };

type AskEvent =
  | { type: "citations"; citations: Citation[]; queries: string[]; candidatesRetrieved: number; candidatesUsed: number }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string }
  | { type: "error"; message: string };

type ProjectOption = { id: string; name: string };

export function AskBar({ projects }: { projects: ProjectOption[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [queries, setQueries] = useState<string[]>([]);
  const [counts, setCounts] = useState<{ retrieved: number; used: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "streaming" | "error">("idle");
  const [error, setError] = useState("");
  const [handoffContext, setHandoffContext] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // A handoff is a prefill, not an automatic submission: reading a report must not
  // spend a model call the reader did not ask for.
  useEffect(
    () =>
      onAskRequest(({ projectId: requested, question, context }) => {
        if (projects.some((project) => project.id === requested)) setProjectId(requested);
        setQuestion(question);
        setHandoffContext(context);
        inputRef.current?.focus();
      }),
    [projects],
  );

  if (projects.length === 0) return null;

  async function ask() {
    const trimmed = question.trim();
    if (trimmed.length < 3 || projectId.length === 0) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAnswer("");
    setCitations([]);
    setQueries([]);
    setCounts(null);
    setError("");
    setStatus("streaming");

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed, projectId }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error((detail as { error?: string }).error ?? "The ask request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const { events, rest } = drainSseEvents<AskEvent>(buffer);
        buffer = rest;

        for (const event of events) {
          if (event.type === "citations") {
            setCitations(event.citations);
            setQueries(event.queries);
            setCounts({ retrieved: event.candidatesRetrieved, used: event.candidatesUsed });
          } else if (event.type === "delta") {
            setAnswer((previous) => previous + event.text);
          } else if (event.type === "error") {
            setError(event.message);
            setStatus("error");
          } else if (event.type === "done") {
            setStatus("idle");
          }
        }
      }

      setStatus((previous) => (previous === "error" ? previous : "idle"));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "The ask request failed.");
      setStatus("error");
    }
  }

  return (
    <section className="panel px-5 py-4" aria-labelledby="ask-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="ask-heading" className="text-[15px] font-medium">
          Ask about this codebase
        </h2>
        <select
          aria-label="Project to ask about"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-[12px] text-[var(--foreground)]"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {/* The question box is the widest thing here on purpose: it is the one control
            in this card, and everything else is its result. */}
        <textarea
          ref={inputRef}
          // A placeholder is not a label: the control needs an accessible name of its
          // own, and this is the control a report handoff sends focus to.
          aria-label="Your question about this codebase"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
          rows={2}
          placeholder="e.g. why does the loyalty recalculation fail under load?"
          className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)]"
        />
        {handoffContext.length > 0 && (
          <p className="meta" role="status">
            Question prepared from: {handoffContext} — edit it or press Ask.
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void ask()}
            disabled={status === "streaming" || question.trim().length < 3}
            className="btn btn-primary"
          >
            {status === "streaming" ? "Searching and reading…" : "Ask"}
          </button>
          {counts && (
            <span className="meta">
              grounded in {counts.used} of {counts.retrieved} retrieved chunks
            </span>
          )}
        </div>
      </div>

      {QueriesSearched(queries)}

      {citations.length > 0 && (
        <ul aria-label="Retrieved sources" className="mt-4 flex flex-wrap gap-1.5">
          {citations.map((citation) => (
            <li
              key={citation.source}
              className="tile border border-[var(--border-subtle)] px-2 py-1 text-[11.5px] text-[var(--muted)] break-all"
            >
              {citation.source}
            </li>
          ))}
        </ul>
      )}

      {answer.length > 0 && (
        <p className="report-prose measure mt-4 whitespace-pre-wrap">{answer}</p>
      )}

      {error.length > 0 && (
        // An error the reader did ask for (they pressed Ask) and one they did not (a
        // stream failing mid-answer) both land here; `role="alert"` announces it, and
        // the Ask button above is the retry, so no separate retry control is needed.
        <p
          role="alert"
          className="note mt-3 border-l-2 border-l-[var(--risk-critical)] border-solid text-[13px] text-[var(--risk-critical)]"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/** The queries actually searched, shown so the expansion is auditable rather than invisible. */
function QueriesSearched(queries: string[]) {
  if (queries.length <= 1) return null;
  return (
    <p className="meta mt-3">
      searched {queries.length} queries: {queries.map((query) => `“${query}”`).join(" · ")}
    </p>
  );
}
