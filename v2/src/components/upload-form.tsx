"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { uploadProjectAction } from "@/app/actions/upload";
import { initialUploadState, type UploadState } from "@/app/actions/upload-state";

/**
 * The upload card.
 *
 * Shaped as one compressed step rather than a form to fill in: the heading and its
 * one-line description on the left, the file and the primary action on the right,
 * and everything optional (duplicate handling, operational data) on a second row
 * behind a hairline. The card used to be the tallest thing on the page, which put
 * the reader's own projects below the fold on a laptop.
 *
 * Nothing about the submission changed — same action, same fields, same states.
 */

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-primary btn-lg">
      {pending ? "Indexing… this embeds every chunk" : "Analyse this codebase"}
    </button>
  );
}

const tone: Record<UploadState["status"], string> = {
  idle: "border-[var(--border)] text-[var(--muted)]",
  success: "border-[var(--risk-low)] text-[var(--risk-low)]",
  error: "border-[var(--risk-critical)] text-[var(--risk-critical)]",
};

const FILE_INPUT_CLASSES =
  "block w-full min-w-0 text-[13px] text-[var(--muted)] file:mr-3 file:rounded-md file:border file:border-[var(--border)] file:bg-[var(--surface-raised)] file:px-3 file:py-1.5 file:text-[13px] file:text-[var(--foreground)] file:cursor-pointer";

export function UploadForm() {
  const [state, action] = useActionState(uploadProjectAction, initialUploadState);

  return (
    <form action={action} className="panel px-5 py-4 lg:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="min-w-0">
          <p className="eyebrow">Step 1</p>
          <h2 className="mt-1 text-base font-medium sm:text-[17px]">Upload a legacy codebase</h2>
          <p className="caption measure mt-1">
            A <code>.zip</code> of the source tree. Ground-truth directories are excluded from indexing
            automatically.
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center lg:w-auto">
          <input
            type="file"
            name="archive"
            accept=".zip,application/zip"
            // The form's heading describes the field visually, but a control still needs a
            // name of its own — the file input has no visible label to point at.
            aria-label="Source archive (.zip)"
            required
            className={FILE_INPUT_CLASSES}
          />
          <SubmitButton />
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
        <label className="flex items-center gap-2 text-[13px] text-[var(--muted)]">
          <input type="checkbox" name="override" className="accent-[var(--accent)]" />
          Re-ingest duplicates (creates a second project from identical bytes)
        </label>

        {/* The plan's first optional enrichment point: collapsed, ignorable, and on
            the same screen. Nothing here is required for the fast path — an empty
            archive still produces the five code-only scores. */}
        <details className="mt-3">
          <summary className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
            <span aria-hidden className="marker">
              ›
            </span>
            <span>Add operational data for more accurate results</span>
            <span className="meta">optional — logs, health/traffic JSON, incident reports</span>
          </summary>
          <div className="mt-3 flex flex-col gap-2 border-l border-[var(--border-subtle)] pl-3">
            <label htmlFor="upload-operationalFiles" className="text-xs text-[var(--foreground)]">
              Operational data files
            </label>
            <input
              id="upload-operationalFiles"
              type="file"
              name="operationalFiles"
              multiple
              accept=".log,.json,.txt,.md"
              aria-describedby="upload-operationalFiles-hint"
              className={FILE_INPUT_CLASSES}
            />
            <p id="upload-operationalFiles-hint" className="meta measure">
              They sharpen <strong>Risk</strong> with measured data — uploaded files are optional and are
              never sent to a model. You can also add or remove them later from the scorecard.
            </p>
          </div>
        </details>
      </div>

      {state.status !== "idle" && (
        <div className={`mt-4 rounded-md border px-3 py-2 text-[13px] ${tone[state.status]}`} role="status">
          <p>{state.message}</p>
          {state.detail && <p className="mt-1 text-[var(--muted)]">{state.detail}</p>}
          {state.operationalErrors && state.operationalErrors.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-[var(--risk-medium)]">
                The project was created; these operational data files were not stored:
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-[var(--muted)]">
                {state.operationalErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
