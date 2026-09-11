// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SCORE_LABELS, SCORE_NAMES, explainScorecard } from "@/lib/scoring/explain";
import {
  computeScorecard,
  type ScorecardInput,
  type ScoringDependency,
  type ScoringFinding,
} from "@/lib/scoring/rubric";

import { Scorecard } from "./scorecard";

/**
 * The scorecard's presentation contract.
 *
 * The scores themselves are the rubric's and are covered by the scoring suites;
 * what is asserted here is how they are shown, because that is what changed: six
 * metrics in one row on a wide screen, each primary score drawn as a ring with the
 * number at its centre, and an accessible name on every ring so the figure is
 * announced as a score rather than as decoration.
 *
 * The findings are literals rather than the checked-in fixture on disk: this suite
 * runs in jsdom, where the fixture loader (which resolves a path from
 * `import.meta.url`) cannot be imported. The numbers still come from the real
 * rubric — nothing here hand-computes a score.
 */

afterEach(cleanup);

const FINDINGS: ScoringFinding[] = [
  {
    serviceName: "OrderService",
    riskLevel: "critical",
    hasTestCoverageGap: true,
    dataQualityIssueCount: 3,
    requiresMajorRestructuring: true,
    dependentCount: 2,
  },
  {
    serviceName: "InventoryService",
    riskLevel: "high",
    hasTestCoverageGap: false,
    dataQualityIssueCount: 1,
    requiresMajorRestructuring: false,
    dependentCount: 1,
  },
  {
    serviceName: "BillingService",
    riskLevel: "medium",
    hasTestCoverageGap: true,
    dataQualityIssueCount: 2,
    requiresMajorRestructuring: false,
    dependentCount: 0,
  },
];

const DEPENDENCIES: ScoringDependency[] = [
  { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
  { fromService: "OrderService", toService: "BillingService", type: "async_event" },
];

function renderScorecard() {
  const input: ScorecardInput = { findings: FINDINGS, dependencies: DEPENDENCIES };

  const scorecard = computeScorecard(input);
  const explanation = explainScorecard(input);

  render(<Scorecard scorecard={scorecard} explanation={explanation} />);

  return { scorecard, explanation };
}

/** The six metric cells of the primary grid, in order: the five scores, then assumptions. */
function metricCells(): HTMLElement[] {
  const grid = screen.getByRole("list", { name: "Primary metrics" });
  return Array.from(grid.querySelectorAll<HTMLElement>(":scope > li"));
}

describe("scorecard structure", () => {
  it("shows the five primary scores and the assumptions as six metrics", () => {
    renderScorecard();

    const cells = metricCells();
    expect(cells).toHaveLength(6);
    expect(SCORE_NAMES).toHaveLength(5);

    SCORE_NAMES.forEach((name, index) => {
      expect(cells[index]?.textContent).toContain(SCORE_LABELS[name]);
    });
    expect(cells[5]?.textContent).toContain("Assumptions");
  });

  it("lays the six metrics out in one row on a wide screen and narrows on smaller ones", () => {
    renderScorecard();

    const grid = screen.getByRole("list", { name: "Primary metrics" });
    // Six columns up front, three then two as the viewport narrows, one when stacked.
    expect(grid.className).toContain("xl:grid-cols-6");
    expect(grid.className).toContain("lg:grid-cols-3");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).toContain("grid-cols-1");
  });

  it("keeps every cell shrinkable so the wide layout cannot overflow", () => {
    renderScorecard();

    const cells = metricCells();
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.className).toContain("min-w-0");
    }
  });

  it("keeps the scorecard's provenance statement", () => {
    const { explanation } = renderScorecard();
    // The confidence tag is on every card as well as in the header, so this is a
    // presence check rather than a uniqueness one.
    expect(screen.getAllByText(explanation.confidenceLabel).length).toBeGreaterThan(1);
    expect(screen.getByText(/no model generates these numbers/)).toBeTruthy();
  });
});

describe("circular score cards", () => {
  it("gives every primary score a ring labelled with its metric and value", () => {
    const { explanation } = renderScorecard();

    const expected: Record<string, string> = {
      readiness: `${SCORE_LABELS.readiness}: ${explanation.scores.readiness.value.toFixed(1)} / 100`,
      risk: `${SCORE_LABELS.risk}: ${explanation.scores.risk.value.toFixed(1)} / 100`,
      effort: `${SCORE_LABELS.effort}: ${explanation.scores.effort.value.toFixed(1)} / 10`,
      cost: `${SCORE_LABELS.cost}: ${Math.round(explanation.scores.cost.value).toLocaleString("en-US")} ${explanation.scores.cost.unit}`,
      time: `${SCORE_LABELS.time}: ${explanation.scores.time.value} weeks`,
    };

    for (const name of SCORE_NAMES) {
      const ring = screen.getByRole("img", { name: expected[name] as string });
      expect(ring.getAttribute("aria-label")).toBe(expected[name]);
    }
  });

  it("draws the score inside the ring and keeps the explanation outside it", () => {
    const { explanation } = renderScorecard();
    const readiness = explanation.scores.readiness;

    const ring = screen.getByRole("img", { name: /^Migration Readiness: / });

    // The number and its unit sit inside the circle...
    expect(ring.textContent).toContain(readiness.value.toFixed(1));
    expect(ring.textContent).toContain("/ 100");
    // ...and the prose does not: a circle is for the one number it is about.
    expect(ring.textContent).not.toContain(readiness.summary);
  });

  it("hides the ring's internals from assistive technology so the score is announced once", () => {
    renderScorecard();

    const ring = screen.getByRole("img", { name: /^Risk: / });
    expect(ring.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the confidence state and evidence level on the cards", () => {
    const { explanation } = renderScorecard();

    // The confidence tag appears on the card and once in the header statement.
    expect(screen.getAllByText(explanation.confidenceLabel).length).toBeGreaterThanOrEqual(6);
    expect(screen.getAllByText(`${explanation.evidence.level} evidence`).length).toBe(5);
  });

  it("shows the time band alongside its mid estimate", () => {
    const { explanation } = renderScorecard();
    // The ring carries the representative figure; the range it came from is shown too.
    const timeCell = metricCells()[SCORE_NAMES.indexOf("time")];
    expect(timeCell?.textContent).toContain(explanation.scores.time.formatted);
  });

  it("clips the explanation on the card and keeps the whole of it behind the disclosure", () => {
    const { explanation } = renderScorecard();
    const readiness = explanation.scores.readiness;

    const cell = metricCells()[SCORE_NAMES.indexOf("readiness")] as HTMLElement;
    const clipped = Array.from(cell.querySelectorAll("p")).find(
      (paragraph) => paragraph.getAttribute("aria-hidden") === "true",
    ) as HTMLElement;

    // The visible one-liner is a *clip*, so it is hidden from assistive technology
    // rather than read as the whole explanation...
    expect(clipped.textContent).toBe(readiness.summary);
    expect(clipped.className).toContain("line-clamp-2");

    // ...and the same sentence in full is the first thing inside the disclosure.
    const body = cell.querySelector("details > div") as HTMLElement;
    expect(body.textContent).toContain(readiness.summary);
    expect(body.querySelector("p.report-prose")?.textContent).toBe(readiness.summary);
  });

  it("labels every tile's disclosure and marks its chevron as decoration", () => {
    renderScorecard();

    const grid = screen.getByRole("list", { name: "Primary metrics" });
    const summaries = Array.from(grid.querySelectorAll<HTMLElement>("details > summary"));
    expect(summaries).toHaveLength(6);

    for (const summary of summaries) {
      expect(summary.textContent).toContain("Why this number");
      const marker = summary.querySelector(".marker");
      expect(marker?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("treats the assumptions as the sixth metric, with no invented ring", () => {
    renderScorecard();

    const assumptions = metricCells()[5] as HTMLElement;

    expect(assumptions.textContent).toContain("Assumptions");
    expect(assumptions.textContent).toContain("engineers × blended weekly rate");
    // Five rings, and no sixth: a team size is not a score, and an arc for it would
    // say more about the drawing than about the estimate.
    expect(screen.getAllByRole("img")).toHaveLength(5);
    expect(assumptions.querySelector('[role="img"]')).toBeNull();
  });

  it("keeps each score expandable into its arithmetic", () => {
    const { explanation } = renderScorecard();

    // Five score disclosures plus the assumptions one.
    const disclosures = document.querySelectorAll("details");
    expect(disclosures.length).toBeGreaterThanOrEqual(6);
    expect(screen.getByText(explanation.scores.risk.formula));
  });
});
