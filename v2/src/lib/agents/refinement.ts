import { critiqueGaps, isCritiqueComplete } from "./critique";

/**
 * The bounded self-critique / refinement cycle.
 *
 * V1 ran this as an agent method with a one-round bound expressed in prose ("bounded
 * to exactly ONE refinement round"). Here the bound is structural rather than
 * documentary: this function is straight-line code with no loop and no
 * recursion, so there is no code path that can request a second refinement.
 * A comment saying "max one round" can drift; a function that cannot loop
 * cannot.
 *
 * The consequences that fall out of that shape, and are what the tests assert:
 *
 * - `critique` is called exactly once per refinement cycle. There is no second
 *   critique, therefore no second refinement trigger.
 * - When the first critique says complete, `refine` is never called.
 * - A refinement that itself produces a flawed report is NOT re-critiqued — it is
 *   accepted. That is the deliberate cost/quality tradeoff V1 documented:
 *   unbounded critique loops find fresh nitpicks each pass without materially
 *   improving output past the first correction, and each round is a full
 *   tool-calling conversation.
 */

/** Product requirement, not a tuning knob. Exposed so tests can assert against it. */
export const MAX_REFINEMENT_ROUNDS = 1;

export type RefinementOutcome = {
  /** The report to use — either the first draft or the single refinement. */
  finalText: string;
  /** The critique text that gated the decision, for logging and run diagnostics. */
  critique: string | null;
  wasRefined: boolean;
  /** Always 1: the cycle critiques once and never re-critiques. */
  critiqueCalls: number;
  /** Always 1: a refinement replaces a draft, it does not add one. */
  draftCalls: number;
  /** 0 or 1, never more. */
  refinementRounds: number;
};

export type BoundedRefinementInput = {
  /** Produces the first draft. */
  draft: () => Promise<string>;
  /** Reviews a draft against a completeness checklist. One call, always. */
  critique: (draft: string) => Promise<string>;
  /** Produces the revised draft from the original plus the identified gaps. */
  refine: (draft: string, gaps: string) => Promise<string>;
};

export async function runBoundedRefinement(input: BoundedRefinementInput): Promise<RefinementOutcome> {
  const firstDraft = await input.draft();
  const critique = await input.critique(firstDraft);

  if (isCritiqueComplete(critique)) {
    return {
      finalText: firstDraft,
      critique,
      wasRefined: false,
      critiqueCalls: 1,
      draftCalls: 1,
      refinementRounds: 0,
    };
  }

  const gaps = critiqueGaps(critique) ?? "The report did not confirm completeness.";

  if (MAX_REFINEMENT_ROUNDS < 1) {
    // Unreachable with the current constant; present so that lowering the bound
    // to zero degrades to "accept the draft" rather than throwing.
    return {
      finalText: firstDraft,
      critique,
      wasRefined: false,
      critiqueCalls: 1,
      draftCalls: 1,
      refinementRounds: 0,
    };
  }

  const refined = await input.refine(firstDraft, gaps);

  return {
    finalText: refined,
    critique,
    wasRefined: true,
    critiqueCalls: 1,
    draftCalls: 1,
    refinementRounds: 1,
  };
}
