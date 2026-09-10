"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { initialUploadState, uploadProjectAction } from "@/app/actions/upload";
import type { UploadState } from "@/app/actions/upload";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#06121f] disabled:opacity-60"
    >
      {pending ? "Indexing… this embeds every chunk" : "Analyse this codebase"}
    </button>
  );
}

const tone: Record<UploadState["status"], string> = {
  idle: "border-[var(--border)] text-[var(--muted)]",
  success: "border-[var(--risk-low)] text-[var(--risk-low)]",
  error: "border-[var(--risk-critical)] text-[var(--risk-critical)]",
};

export function UploadForm() {
  const [state, action] = useActionState(uploadProjectAction, initialUploadState);

  return (
    <form action={action} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="text-base font-medium">Upload a codebase</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        A <code>.zip</code> of the source tree. Ground-truth directories are excluded from indexing
        automatically.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <input
          type="file"
          name="archive"
          accept=".zip,application/zip"
          required
          className="block w-full text-sm text-[var(--muted)] file:mr-3 file:rounded-md file:border file:border-[var(--border)] file:bg-[var(--surface-raised)] file:px-3 file:py-1.5 file:text-sm file:text-[var(--foreground)]"
        />

        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input type="checkbox" name="override" className="accent-[var(--accent)]" />
          Re-ingest duplicates (creates a second project from identical bytes)
        </label>

        <div>
          <SubmitButton />
        </div>
      </div>

      {state.status !== "idle" && (
        <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${tone[state.status]}`} role="status">
          <p>{state.message}</p>
          {state.detail && <p className="mt-1 text-[var(--muted)]">{state.detail}</p>}
        </div>
      )}
    </form>
  );
}
