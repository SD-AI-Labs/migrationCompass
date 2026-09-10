import { describe, expect, it } from "vitest";

import { MAX_REFINEMENT_ROUNDS, runBoundedRefinement } from "./refinement";

/**
 * The bound is the requirement, so these tests assert call counts rather than
 * outcomes: "one refinement happened" is weaker than "a second critique was never
 * requested", and it is the second claim the design actually makes.
 */

type Counters = {
  draft: number;
  critique: number;
  refine: number;
};

function harness(critiqueText: string, options: { refineThrows?: boolean } = {}) {
  const counters: Counters = { draft: 0, critique: 0, refine: 0 };

  return {
    counters,
    input: {
      draft: async () => {
        counters.draft += 1;
        return "first draft";
      },
      critique: async () => {
        counters.critique += 1;
        return critiqueText;
      },
      refine: async (_draft: string, gaps: string) => {
        counters.refine += 1;
        if (options.refineThrows) throw new Error("refinement model unavailable");
        return `refined draft addressing: ${gaps}`;
      },
    },
  };
}

describe("MAX_REFINEMENT_ROUNDS", () => {
  it("is exactly one", () => {
    expect(MAX_REFINEMENT_ROUNDS).toBe(1);
  });
});

describe("runBoundedRefinement", () => {
  it("does not refine when the first critique says complete", async () => {
    const { input, counters } = harness("Complete");
    const outcome = await runBoundedRefinement(input);

    expect(outcome.wasRefined).toBe(false);
    expect(outcome.finalText).toBe("first draft");
    expect(counters).toEqual({ draft: 1, critique: 1, refine: 0 });
  });

  it("refines exactly once when the first critique finds gaps", async () => {
    const { input, counters } = harness("Missing the database overview");
    const outcome = await runBoundedRefinement(input);

    expect(outcome.wasRefined).toBe(true);
    expect(outcome.refinementRounds).toBe(1);
    expect(outcome.finalText).toContain("Missing the database overview");
    expect(counters).toEqual({ draft: 1, critique: 1, refine: 1 });
  });

  it("treats 'Complete except…' as a gap and refines", async () => {
    // The trap, exercised through the refinement cycle rather than the parser
    // alone: this critique must produce a refinement, not a shipped gap.
    const { input, counters } = harness("Complete except the database schema was not checked");
    const outcome = await runBoundedRefinement(input);

    expect(outcome.wasRefined).toBe(true);
    expect(counters.refine).toBe(1);
  });

  it("never requests a second critique, so a second refinement cannot be triggered", async () => {
    // The mechanism, not just the outcome: the cycle critiques once. With no
    // second critique there is nothing that could start a second refinement, and
    // this holds whatever the refinement produced.
    const { input, counters } = harness("Still incomplete after refinement");

    const outcome = await runBoundedRefinement(input);

    expect(counters.critique).toBe(1);
    expect(outcome.critiqueCalls).toBe(1);
    expect(outcome.refinementRounds).toBeLessThanOrEqual(MAX_REFINEMENT_ROUNDS);
  });

  it("bounds the refinement count for every kind of critique", async () => {
    const critiques = [
      "Complete",
      "Complete.",
      "Complete except X",
      "Complete, but Y",
      "Incomplete",
      "",
      "   ",
      "A very long list of gaps indeed",
    ];

    for (const critique of critiques) {
      const { input, counters } = harness(critique);
      const outcome = await runBoundedRefinement(input);

      expect(outcome.refinementRounds).toBeLessThanOrEqual(MAX_REFINEMENT_ROUNDS);
      expect(counters.critique).toBe(1);
      expect(counters.refine).toBeLessThanOrEqual(1);
      expect(counters.draft).toBe(1);
    }
  });

  it("surfaces a refinement failure instead of silently keeping the draft", async () => {
    // Swallowing this would turn "the model is down" into a run that looks
    // successful with a knowingly incomplete report.
    const { input } = harness("Gaps found", { refineThrows: true });
    await expect(runBoundedRefinement(input)).rejects.toThrow(/refinement model unavailable/);
  });

  it("surfaces a draft failure rather than refining nothing", async () => {
    const input = {
      draft: async () => {
        throw new Error("draft model unavailable");
      },
      critique: async () => "Complete",
      refine: async () => "unused",
    };
    await expect(runBoundedRefinement(input)).rejects.toThrow(/draft model unavailable/);
  });

  it("reports the critique it acted on, for run diagnostics", async () => {
    const { input } = harness("Complete except the messaging layer");
    const outcome = await runBoundedRefinement(input);
    expect(outcome.critique).toBe("Complete except the messaging layer");
  });
});
