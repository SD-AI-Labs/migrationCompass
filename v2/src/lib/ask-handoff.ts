/**
 * The handoff from a report section or finding into the existing ask bar.
 *
 * The plan's M7 rule is "inline ask from any card" and "never a second
 * conversational system". So this is a channel, not a chat client: a report
 * control publishes the question it wants asked (already carrying the section's
 * context in its wording), and the ask bar — the one surface that talks to
 * `/api/ask` — picks it up, selects the right project, prefills the box and takes
 * focus. The reader still presses Ask, which keeps the model call an explicit act
 * rather than a side effect of reading a report.
 *
 * A window event rather than context or prop drilling: the report is rendered
 * inside a server component tree several levels above the ask bar, and a React
 * context would force a client boundary around all of it. The event is
 * server-safe (it is a no-op when there is no `window`), so importing this module
 * from a server component cannot crash a render.
 */

export const ASK_HANDOFF_EVENT = "migration-compass:ask";

export type AskHandoffRequest = {
  /** The project the question is about, so the ask bar can switch selection. */
  projectId: string;
  /** The question, composed by the report from the section or finding it came from. */
  question: string;
  /** What it came from, shown to the reader so the handoff is legible. */
  context: string;
};

/** Publishes a question for the ask bar. Does nothing outside the browser. */
export function requestAsk(request: AskHandoffRequest): void {
  if (typeof window === "undefined") return;
  if (request.question.trim().length === 0 || request.projectId.length === 0) return;
  window.dispatchEvent(new CustomEvent<AskHandoffRequest>(ASK_HANDOFF_EVENT, { detail: request }));
}

/** Subscribes to handoffs. Returns the unsubscribe function. */
export function onAskRequest(handler: (request: AskHandoffRequest) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: Event): void => {
    const request = (event as CustomEvent<AskHandoffRequest>).detail;
    if (!request || typeof request.question !== "string" || typeof request.projectId !== "string") return;
    handler(request);
  };

  window.addEventListener(ASK_HANDOFF_EVENT, listener);
  return () => window.removeEventListener(ASK_HANDOFF_EVENT, listener);
}
