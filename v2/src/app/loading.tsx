/**
 * The home page's streaming state.
 *
 * The page reads the session, the project list, each project's latest run, its
 * scorecard and its indexed sources before it can render anything, and on a slow
 * database that is a visible wait. This is what Next streams in the meantime.
 *
 * It is shaped like the page it becomes — header, upload card, project rows with a
 * six-metric scorecard — so the arrival of the real content does not move anything.
 * The shapes are decorative (`aria-hidden`) and carry no invented numbers: a screen
 * reader gets one sentence saying what is loading, and a sighted reader gets a page
 * that is already the right size.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-[1600px] px-5 py-10 sm:px-8 lg:px-12 lg:py-12">
      <header>
        <h1 className="text-[1.75rem] font-semibold tracking-tight sm:text-[2rem]">Migration Compass</h1>
        <p role="status" className="caption measure mt-1.5 text-[0.9375rem] leading-relaxed">
          Loading your projects and their analyses…
        </p>
      </header>

      <div aria-hidden className="mt-8 flex animate-pulse flex-col gap-8 lg:gap-10">
        {/* The upload step: a heading, its one-line description, the file and the action. */}
        <div className="panel flex flex-col justify-between gap-4 px-5 py-4 lg:flex-row lg:items-end lg:px-6">
          <div className="min-w-0">
            <div className="h-2.5 w-14 rounded bg-[var(--surface-raised)]" />
            <div className="mt-2.5 h-4 w-56 rounded bg-[var(--surface-raised)]" />
            <div className="mt-3 h-2.5 w-72 max-w-full rounded bg-[var(--surface-raised)]" />
          </div>
          <div className="flex gap-2">
            <div className="h-9 w-52 rounded-md bg-[var(--surface-raised)]" />
            <div className="h-9 w-40 rounded-md bg-[var(--surface-raised)]" />
          </div>
        </div>

        {/* The project list: rows, then the six-metric scorecard of a completed run. */}
        <div>
          <div className="h-2.5 w-20 rounded bg-[var(--surface-raised)]" />
          <div className="panel-bare mt-3 flex flex-col">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="border-b border-[var(--border-subtle)] px-5 py-4 last:border-b-0"
              >
                <div className="h-4 w-56 max-w-full rounded bg-[var(--surface-raised)]" />
                <div className="mt-2 h-2.5 w-72 max-w-full rounded bg-[var(--surface-raised)]" />
                <div className="mt-2 h-2.5 w-48 rounded bg-[var(--surface-raised)]" />

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                  {[0, 1, 2, 3, 4, 5].map((tile) => (
                    <div key={tile} className="tile flex flex-col items-center p-4">
                      <div className="h-2.5 w-16 rounded bg-[var(--surface)]" />
                      <div className="mt-3 size-25 rounded-full border-8 border-[var(--surface)]" />
                      <div className="mt-3 h-2.5 w-24 rounded bg-[var(--surface)]" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
