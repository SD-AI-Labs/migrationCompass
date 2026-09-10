import { getProjects } from '../api/client'

// Minimal shared cache + pub/sub for the project list — needed because
// every page in App.jsx now stays permanently mounted (see App.jsx's
// comment on that, from the earlier Agent-tab polling fix), so each
// page's own <ProjectPicker> only ever fetched once, on the app's
// initial load, and never again. Without this, deleting a project on
// the RAG tab (or uploading a new one) had no way to reach the Agent or
// Reports tabs' already-mounted, separate ProjectPicker instances.
//
// Deliberately NOT a full state-management library — this app has no
// other shared client state, so a tiny module-level cache + listener set
// is proportionate. If more shared state shows up later, worth
// reconsidering something like React Context instead of growing this
// pattern ad hoc.

let cachedProjects = null;
const listeners = new Set();

export function getCachedProjects() {
  return cachedProjects;
}

export function subscribeToProjects(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Call this after ANY action that adds/removes a project (upload, delete) — not just from the page that triggered it. */
export async function refreshProjects() {
  const projects = await getProjects();
  cachedProjects = projects;
  listeners.forEach((cb) => cb(projects));
  return projects;
}
