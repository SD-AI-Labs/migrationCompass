/**
 * Refinement form state.
 *
 * Kept out of the `"use server"` action module for the reason recorded in
 * `upload-state.ts`: Next.js requires every export of a Server Action file to be an
 * async function, so the state type and its initial value live beside it in a
 * normal module that both the action and the client component can import.
 *
 * The state carries the same two things the form has to be honest about: what was
 * accepted, and what was rejected and why. A partial success — three files read,
 * one unparseable — is reported as a partial success rather than as either
 * "saved" or "failed".
 */

export type RefineState = {
  status: "idle" | "success" | "partial" | "error";
  message: string;
  /** Per-file rejections, each naming the file it came from. */
  errors?: string[];
  /** What the recalculation changed, in one deterministic sentence. */
  detail?: string;
  /** How many operational data files are now stored for this project. */
  storedFiles?: number;
};

export const initialRefineState: RefineState = { status: "idle", message: "" };

export type RemoveOperationalState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialRemoveOperationalState: RemoveOperationalState = { status: "idle", message: "" };
