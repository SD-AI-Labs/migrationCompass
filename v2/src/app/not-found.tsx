import Link from "next/link";

/**
 * The not-found boundary for the whole app.
 *
 * Reached from `notFound()` — currently from the project actions, when the submitted
 * project id belongs to another session or to nothing at all. The wording matters: it
 * says nothing about *which* of those happened, because saying so would confirm that
 * another session's project id exists. Missing and unauthorized are one outcome from
 * the outside, and this page keeps them that way.
 *
 * It also has to be useful without knowing what the reader was doing: the recovery
 * offered is the one that always exists — go back to the project list.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-[1600px] px-5 py-10 sm:px-8 lg:px-12 lg:py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Not found</h1>
      <p className="caption measure mt-2">
        That resource is not visible to this session. It may have been deleted, or it may belong to
        another session — those two are deliberately indistinguishable, because telling them apart
        would confirm that someone else&apos;s project id exists.
      </p>
      <p className="caption measure mt-2">
        Nothing was changed. Projects, their analyses and their traces are scoped to the browser
        session that created them.
      </p>

      <p className="mt-6">
        <Link href="/" className="text-[var(--accent)] hover:underline">
          Back to the project list
        </Link>
      </p>
    </main>
  );
}
