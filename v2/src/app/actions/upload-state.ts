/**
 * Upload form state.
 *
 * Deliberately NOT in the `"use server"` module. Next.js requires every export
 * from a Server Action file to be an async function, and a plain object export
 * fails the build with:
 *
 *   A "use server" file can only export async functions, found object.
 *
 * The state value is consumed by a client component (`useActionState`), so it has
 * to live somewhere importable from both sides. Splitting it into a normal module
 * is the documented fix and keeps the action module to actions only.
 */

export type UploadState = {
  status: "idle" | "success" | "error";
  message: string;
  detail?: string;
  projectId?: string;
  /** Per-file problems with the *optional* operational data, listed separately. */
  operationalErrors?: string[];
};

export const initialUploadState: UploadState = { status: "idle", message: "" };
