import { describe, expect, it } from "vitest";

import { COMPLETE_TOKEN, critiqueGaps, isCritiqueComplete, normalizeCritique } from "./critique";

/**
 * The critique parser gates every refinement decision in the pipeline, so it gets
 * exhaustive treatment — including the specific false-negative trap the plan
 * calls out by name.
 */

describe("isCritiqueComplete — the four required cases", () => {
  it("treats an exact COMPLETE as complete", () => {
    expect(isCritiqueComplete("Complete")).toBe(true);
  });

  it("treats 'Complete except…' as INCOMPLETE", () => {
    // The trap. A permissive parser reads this as approval, skips the refinement
    // round, and ships a report with a known gap in it.
    expect(isCritiqueComplete("Complete except the database schema was never checked")).toBe(false);
  });

  it("treats 'Complete, but…' as INCOMPLETE", () => {
    expect(isCritiqueComplete("Complete, but the messaging layer was not investigated")).toBe(false);
  });

  it("treats 'Complete with…' as INCOMPLETE", () => {
    expect(isCritiqueComplete("Complete with one caveat about test coverage")).toBe(false);
  });

  it("treats a genuinely incomplete critique as INCOMPLETE", () => {
    expect(isCritiqueComplete("Incomplete — no dependency edges were established")).toBe(false);
  });
});

describe("isCritiqueComplete — normalisation contract", () => {
  it("accepts leading and trailing whitespace", () => {
    expect(isCritiqueComplete("   Complete\n")).toBe(true);
    expect(isCritiqueComplete("\tCOMPLETE  ")).toBe(true);
  });

  it("is case-insensitive", () => {
    // Stated contract: an exact word, case-folded. The asymmetry (case-folded but
    // otherwise exact) is what keeps "Complete except…" out.
    expect(isCritiqueComplete("complete")).toBe(true);
    expect(isCritiqueComplete("COMPLETE")).toBe(true);
    expect(isCritiqueComplete("CoMpLeTe")).toBe(true);
  });

  it("accepts a trailing period, which models add despite instructions", () => {
    expect(isCritiqueComplete("Complete.")).toBe(true);
    expect(isCritiqueComplete("COMPLETE!")).toBe(true);
  });

  it("accepts wrapping quotes and emphasis", () => {
    expect(isCritiqueComplete('"Complete"')).toBe(true);
    expect(isCritiqueComplete("**Complete**")).toBe(true);
  });

  it("does NOT accept a sentence that merely starts with the word", () => {
    for (const critique of [
      "Completely done",
      "Completeness is fine",
      "Complete-ish",
      "Completed",
    ]) {
      expect(isCritiqueComplete(critique)).toBe(false);
    }
  });

  it("does not accept an empty or whitespace-only critique", () => {
    expect(isCritiqueComplete("")).toBe(false);
    expect(isCritiqueComplete("   ")).toBe(false);
  });

  it("does not accept null or undefined", () => {
    // Silence is not approval: a model that returned nothing confirmed nothing.
    expect(isCritiqueComplete(null)).toBe(false);
    expect(isCritiqueComplete(undefined)).toBe(false);
  });

  it("does not strip punctuation from the middle of a critique", () => {
    // Stripping interior punctuation is how a "complete, but…" would collapse
    // into something that compares equal to the token.
    expect(isCritiqueComplete("complete, but the schema was skipped")).toBe(false);
  });
});

describe("normalizeCritique", () => {
  it("exposes the comparison value the contract is defined on", () => {
    expect(normalizeCritique("  COMPLETE.  ")).toBe(COMPLETE_TOKEN);
    expect(normalizeCritique("Complete except X")).toBe("complete except x");
  });
});

describe("critiqueGaps", () => {
  it("returns null when nothing is missing", () => {
    expect(critiqueGaps("Complete")).toBeNull();
  });

  it("returns the critique text when something is missing", () => {
    const critique = "Complete except the database schema was never checked";
    expect(critiqueGaps(critique)).toBe(critique);
  });

  it("never returns an empty gap for a non-complete critique", () => {
    // The refinement prompt needs *something* to act on; an empty string would
    // send the model a refinement instruction with no gaps in it.
    expect(critiqueGaps("   ")).toBeNull();
    expect(critiqueGaps(null)).toBeNull();
  });
});
