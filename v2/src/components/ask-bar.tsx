"use client";

import { useRef, useState } from "react";

import { drainSseEvents } from "@/lib/sse";

/**
 * The persistent ask bar.
 *
 * Present whenever there is a project, never a destination you navigate to —
 * which is the plan's Layer 4 rule. Two behaviours worth noting:
 *
 * - Citations render before the first answer token, because they arrive first.
 *   Showing the evidence while the answer streams is the whole reason the
 *   endpoint streams in two phases instead of one blob.
 * - The retrieved/used counts are displayed prominently ("8 of 41 chunks"),
 *   because an answer that does not say what it looked at invites the reader to
 *   assume it looked at everything.
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
  const abortRef = useRef<AbortController | null>(null);

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
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-medium">Ask about this codebase</h2>
        <select
          aria-label="Project to ask about"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-xs text-[var(--foreground)]"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <textarea
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
          className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void ask()}
            disabled={status === "streaming" || question.trim().length < 3}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#06121f] disabled:opacity-60"
          >
            {status === "streaming" ? "Searching and reading…" : "Ask"}
          </button>
          {counts && (
            <span className="text-xs text-[var(--muted)]">
              grounded in {counts.used} of {counts.retrieved} retrieved chunks
            </span>
          )}
        </div>
      </div>

      {QueriesSearched(queries)}

      {citations.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {citations.map((citation) => (
            <li
              key={citation.source}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-xs text-[var(--muted)]"
            >
              {citation.source}
            </li>
          ))}
        </ul>
      )}

      {answer.length > 0 && (
        <p className="mt-4 text-sm whitespace-pre-wrap">{answer}</p>
      )}

      {error.length > 0 && (
        <p role="status" className="mt-3 rounded-md border border-[var(--risk-critical)] px-3 py-2 text-sm text-[var(--risk-critical)]">
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
    <p className="mt-3 text-xs text-[var(--muted)]">
      searched {queries.length} queries: {queries.map((query) => `“${query}”`).join(" · ")}
    </p>
  );
}
