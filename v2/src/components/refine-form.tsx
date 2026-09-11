"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  refineEstimatesAction,
  removeOperationalDataAction,
} from "@/app/actions/refine";
import {
  initialRefineState,
  initialRemoveOperationalState,
  type RefineState,
} from "@/app/actions/refine-state";
import { OPERATIONAL_FILE_LIMIT_BYTES } from "@/lib/operational/ingest";
import { TARGET_ENVIRONMENTS } from "@/lib/scoring/assumptions";
import type { MigrationParametersInput } from "@/lib/scoring/parameters";

/**
 * "Refine these estimates" — the cheap, instant half of the two-speed model.
 *
 * The plan's split is explicit and this component is where a user meets it:
 *
 * ```
 *   Run analysis            → agent run, minutes, needs a model credential
 *   Refine these estimates  → this form, instant, no model, arithmetic only
 * ```
 *
 * So the copy says what will happen rather than implying the analysis is re-run: the
 * five numbers are recalculated from the same structured findings, and the narrative
 * findings stay exactly as they were until someone explicitly runs the analysis again.
 *
 * Accessibility decisions worth naming:
 *
 * - `<details>` for the disclosure, so it opens with the keyboard and announces its
 *   state without any JavaScript of ours.
 * - every input has a real `<label for>`; the optional ones say "(optional)" in the
 *   label text rather than in a placeholder, which vanishes as soon as you type.
 * - the result region is `role="status"` so a screen reader hears the outcome, and
 *   the file errors are a list a reader can act on one item at a time.
 * - the submit button is disabled while pending, which prevents the same submission
 *   being queued twice.
 */

const TONE: Record<RefineState["status"], string> = {
  idle: "border-[var(--border)] text-[var(--muted)]",
  success: "border-[var(--risk-low)] text-[var(--risk-low)]",
  partial: "border-[var(--risk-medium)] text-[var(--risk-medium)]",
  error: "border-[var(--risk-critical)] text-[var(--risk-critical)]",
};

/** Text and number inputs: one sunken field style, used by every control here. */
const FIELD_CLASSES =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[13px] text-[var(--foreground)]";

const FILE_CLASSES =
  "block w-full min-w-0 text-[13px] text-[var(--muted)] file:mr-3 file:rounded-md file:border file:border-[var(--border)] file:bg-[var(--surface-raised)] file:px-3 file:py-1.5 file:text-[13px] file:text-[var(--foreground)] file:cursor-pointer";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className="btn btn-primary">
      {pending ? pendingLabel : label}
    </button>
  );
}

function RemoveButton() {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className="btn btn-quiet-danger">
      {pending ? "Removing…" : "Remove attached operational data"}
    </button>
  );
}

function NumberField({
  name,
  label,
  hint,
  value,
  step,
  min,
}: {
  name: string;
  label: string;
  hint: string;
  value: number | null;
  step?: string;
  min?: number;
}) {
  const id = `refine-${name}`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-[var(--foreground)]">
        {label} <span className="text-[var(--muted)]">(optional)</span>
      </label>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        defaultValue={value ?? ""}
        aria-describedby={`${id}-hint`}
        className={FIELD_CLASSES}
      />
      <p id={`${id}-hint`} className="meta">
        {hint}
      </p>
    </div>
  );
}

export function RefineEstimatesForm({
  projectId,
  parameters,
  storedFiles,
  isRefined,
}: {
  projectId: string;
  parameters: MigrationParametersInput;
  storedFiles: number;
  isRefined: boolean;
}) {
  const [state, action] = useActionState(refineEstimatesAction, initialRefineState);
  const [removeState, removeAction] = useActionState(
    removeOperationalDataAction,
    initialRemoveOperationalState,
  );

  return (
    <details
      className="row-disclosure"
      open={state.status === "partial" || state.status === "error"}
    >
      <summary className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
        <span className="text-[13.5px] font-medium">Refine these estimates</span>
        <span aria-hidden className="marker col-start-2 row-span-2 self-center">
          ›
        </span>
        <span className="meta col-start-1">
          {isRefined
            ? `refined · ${storedFiles} operational data file(s) stored`
            : "add operational data or migration parameters"}
        </span>
      </summary>

      <p className="caption measure mb-4">
        Recalculates the five scores from the findings already stored for this run. It calls no model and
        changes no narrative — re-run the analysis for a new one. Operational data sharpens <strong>Risk</strong>;
        team size and the blended rate drive <strong>Cost</strong> and <strong>Time</strong>.
      </p>

      <form action={action} className="flex flex-col gap-4 pb-4">
        <input type="hidden" name="projectId" value={projectId} />

        <div className="flex flex-col gap-1">
          <label htmlFor="refine-files" className="text-xs text-[var(--foreground)]">
            Operational data <span className="text-[var(--muted)]">(optional)</span>
          </label>
          <input
            id="refine-files"
            type="file"
            name="operationalFiles"
            multiple
            accept=".log,.json,.txt,.md"
            aria-describedby="refine-files-hint"
            className={FILE_CLASSES}
          />
          <p id="refine-files-hint" className="meta">
            Logs (.log), health/traffic JSON (.json, up to {OPERATIONAL_FILE_LIMIT_BYTES / 1024 / 1024} MB each),
            or incident reports (.md, .txt). Files accumulate; removing them restores the code-only estimate.
          </p>
        </div>

        <fieldset className="rounded-md border border-[var(--border-subtle)] p-3.5">
          <legend className="px-1 eyebrow">Migration parameters</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="refine-targetEnvironment" className="text-xs text-[var(--foreground)]">
                Target environment <span className="text-[var(--muted)]">(optional)</span>
              </label>
              <select
                id="refine-targetEnvironment"
                name="targetEnvironment"
                defaultValue={parameters.targetEnvironment ?? ""}
                aria-describedby="refine-targetEnvironment-hint"
                className={FIELD_CLASSES}
              >
                <option value="">not set</option>
                {TARGET_ENVIRONMENTS.map((environment) => (
                  <option key={environment} value={environment}>
                    {environment}
                  </option>
                ))}
              </select>
              <p id="refine-targetEnvironment-hint" className="meta">
                Recorded on the scorecard. Infrastructure cost by target is not part of the rubric yet.
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="refine-provider" className="text-xs text-[var(--foreground)]">
                Provider <span className="text-[var(--muted)]">(optional)</span>
              </label>
              <input
                id="refine-provider"
                name="provider"
                type="text"
                defaultValue={parameters.provider ?? ""}
                placeholder="e.g. AWS eu-west-1"
                className={FIELD_CLASSES}
              />
            </div>

            <NumberField
              name="teamSize"
              label="Team size (engineers)"
              hint="Scales cost, and adjusts the timeline sublinearly."
              value={parameters.teamSize}
              min={1}
            />
            <NumberField
              name="weeklyRate"
              label="Blended weekly rate"
              hint="Cost = total person-weeks × this rate."
              value={parameters.weeklyRate}
              min={0}
            />
            <NumberField
              name="budget"
              label="Budget"
              hint="Compared against the estimate; a budget does not lower it."
              value={parameters.budget}
              min={0}
            />
            <NumberField
              name="timelineWeeks"
              label="Timeline (weeks)"
              hint="Compared against the estimated duration."
              value={parameters.timelineWeeks}
              min={1}
            />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton label="Refine these estimates" pendingLabel="Recalculating…" />
          {storedFiles > 0 && (
            <span className="meta">{storedFiles} operational data file(s) currently stored</span>
          )}
        </div>
      </form>

      {state.status !== "idle" && (
        <div className={`mb-4 rounded-md border px-3 py-2 text-[13px] ${TONE[state.status]}`} role="status">
          <p>{state.message}</p>
          {state.detail && <p className="mt-1 meta">{state.detail}</p>}
          {state.errors && state.errors.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-[var(--muted)]">
              {state.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {storedFiles > 0 && (
        <form action={removeAction} className="flex flex-wrap items-center gap-3 pb-4">
          <input type="hidden" name="projectId" value={projectId} />
          <RemoveButton />
          <span className="meta">
            The estimates go back to the code-only baseline immediately.
          </span>
        </form>
      )}

      {removeState.status !== "idle" && (
        <p
          role="status"
          className={`mt-2 text-[12px] ${removeState.status === "error" ? "text-[var(--risk-critical)]" : "text-[var(--muted)]"}`}
        >
          {removeState.message}
        </p>
      )}
    </details>
  );
}
