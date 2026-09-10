/**
 * Self-critique parsing.
 *
 * Pure, dependency-free, and deterministic — no LLM, no framework. This is the
 * decision that gates whether a refinement round happens at all, so it is worth
 * being able to test exhaustively.
 *
 * ## The contract
 *
 * A critique counts as complete when, after trimming surrounding whitespace and
 * stripping trailing sentence punctuation, it equals "complete"
 * case-insensitively. Everything else is incomplete.
 *
 * That is deliberately stricter than a `startsWith` or `includes` check, and the
 * strictness is the whole point. The failure mode being guarded against:
 *
 *   "Complete except the database schema was never checked."
 *
 * A permissive parser reads that as "complete", skips the refinement round, and
 * ships a report with a known gap. Treating it as incomplete costs one extra
 * refinement pass; treating it as complete costs a wrong answer. The asymmetry
 * decides the contract.
 */

/** The single token a model must return to signal a complete report. */
export const COMPLETE_TOKEN = "complete";

/**
 * Trailing punctuation that a model adds despite being asked for one word.
 * Only trailing — stripping punctuation inside the string would let
 * "complete, but the schema was skipped" collapse to something shorter.
 */
const TRAILING_PUNCTUATION = /[.!?;:,”"'`*\s]+$/;
const LEADING_PUNCTUATION = /^[“"'`*\s]+/;

/** Normalizes a critique for comparison. Exported so the contract is inspectable. */
export function normalizeCritique(critique: string): string {
  return critique
    .replace(LEADING_PUNCTUATION, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim()
    .toLowerCase();
}

/**
 * True only for an unambiguous complete signal.
 *
 * `null` and empty are incomplete: a model that returned nothing did not confirm
 * anything, and treating silence as approval is the same trap as the
 * "Complete except…" case.
 */
export function isCritiqueComplete(critique: string | null | undefined): boolean {
  if (critique === null || critique === undefined) return false;
  return normalizeCritique(critique) === COMPLETE_TOKEN;
}

/**
 * The gaps a critique identified, for the refinement prompt. Returns null when
 * the critique is complete (nothing to address).
 */
export function critiqueGaps(critique: string | null | undefined): string | null {
  if (isCritiqueComplete(critique)) return null;
  const trimmed = critique?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
