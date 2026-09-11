/**
 * A rendered failure, in the page rather than in a log line.
 *
 * The failure this exists for: a read that fails and is swallowed looks identical to
 * a read that succeeded and found nothing. "No projects yet" is a *claim*, and showing
 * it when the database is unreachable is a false statement about the user's data — the
 * most expensive kind of wrong interface, because it invites them to believe their
 * work is gone.
 *
 * Deliberately server-renderable (no hooks, no state) so a page can state a failure it
 * already knows about at render time. That is why it is a labelled region with a
 * heading rather than `role="alert"`: live-region roles announce *changes*, and a
 * message present in the first paint is not a change. Dynamic errors — the ask bar's,
 * the analysis run's — use `role="alert"` where the message actually appears mid-session.
 *
 * What it must not do: leak the database's own message (a connection string sometimes
 * carries a password), or invent a cause. It states what failed, what that means for
 * the reader, and what to do next; the diagnostic detail stays in the server log.
 */

export function ErrorNotice({
  title,
  detail,
  action,
}: {
  title: string;
  /** What happened and what it means, in the reader's terms. */
  detail: string;
  /** What to do about it, when there is something useful to say. */
  action?: string;
}) {
  return (
    // Named with `aria-label` rather than `aria-labelledby`: several notices can render
    // on one page (one per project whose assessment failed), and a fixed element id
    // would be duplicated and resolve to whichever came first.
    //
    // The accent is a left edge rather than a full red outline: this is one message in
    // a page of results, and outlining it like a card made a database hiccup the
    // loudest thing on the screen.
    <section
      aria-label={title}
      className="panel-quiet border-l-2 border-l-[var(--risk-critical)] px-4 py-3"
    >
      <h2 className="text-[13.5px] font-medium text-[var(--risk-critical)]">{title}</h2>
      <p className="mt-1 measure text-[13px] text-[var(--muted)]">{detail}</p>
      {action && <p className="mt-1 measure text-[13px] text-[var(--foreground)]">{action}</p>}
    </section>
  );
}
