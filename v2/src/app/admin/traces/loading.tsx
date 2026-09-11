/**
 * Loading state for `/admin/traces`.
 *
 * Next.js renders this while the page's server work is in flight, which on this page
 * means reading spans from Postgres. A blank screen during a slow query reads as a
 * broken page, so the shell states what it is waiting for.
 */

export default function TracesLoading() {
  return (
    <main className="mx-auto max-w-[1100px] px-5 py-10 sm:px-8 lg:px-12 lg:py-12" aria-busy="true">
      <header>
        <h1 className="text-[1.75rem] font-semibold tracking-tight sm:text-[2rem]">Traces</h1>
        <p className="caption measure mt-1.5 leading-relaxed" role="status">
          Reading stored spans from Postgres…
        </p>
      </header>

      <div aria-hidden className="mt-8 flex flex-col gap-2.5">
        {[0, 1, 2].map((index) => (
          <div key={index} className="h-14 animate-pulse rounded-[0.625rem] bg-[var(--surface)]" />
        ))}
      </div>
    </main>
  );
}
