// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { discoveryOutputSchema, riskAssessmentSchema } from "@/lib/agents/schemas";
import { ASK_HANDOFF_EVENT, type AskHandoffRequest } from "@/lib/ask-handoff";
import { buildDependencyGraph } from "@/lib/graph/build-graph";
import type { ProjectSummary } from "@/lib/projects/repository";
import { buildAnalysisReport } from "@/lib/report/builder";
import type { AnalysisReport as AnalysisReportModel } from "@/lib/report/types";
import { describeRefinement, recomputeScorecard } from "@/lib/scoring/refine";
import type { ScoringDependency, ScoringFinding } from "@/lib/scoring/rubric";
import type { LoadedScorecard } from "@/lib/scoring/loader";

import { AnalysisReport } from "./analysis-report";

/**
 * The report's rendering contract.
 *
 * The report is built by the real composer from real structured outputs and then
 * rendered, so these tests cover the whole path a reader walks: structured
 * analysis → composed report → the DOM, its disclosure states, its accessible
 * names and its ask handoff. Nothing here needs a model, a database or a network:
 * the report is composed from persisted data by construction.
 */

afterEach(cleanup);

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "legacy-order-platform.zip",
  sourceType: "upload",
  fileCount: 24,
  chunkCount: 131,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

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
    riskLevel: "low",
    hasTestCoverageGap: false,
    dataQualityIssueCount: 0,
    requiresMajorRestructuring: false,
    dependentCount: 1,
  },
];

const DEPENDENCIES: ScoringDependency[] = [
  { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
];

const DISCOVERY = discoveryOutputSchema.parse({
  systemName: "Legacy Order Platform",
  summary: "Two services share one Oracle schema; ordering is the load-bearing component.",
  services: [
    {
      name: "OrderService",
      riskLevel: "critical",
      riskFactors: ["shared mutable schema"],
      recommendation: "Split the schema first.",
      hasTestCoverageGap: true,
      dataQualityIssueCount: 3,
      requiresMajorRestructuring: true,
    },
    {
      name: "InventoryService",
      riskLevel: "low",
      riskFactors: [],
      hasTestCoverageGap: false,
      dataQualityIssueCount: 0,
      requiresMajorRestructuring: false,
    },
  ],
  dependencies: [
    {
      from: "OrderService",
      to: "InventoryService",
      type: "synchronous call",
      evidence: "InventoryRepository injected into OrderService",
    },
  ],
  techStack: ["Java 8", "Oracle 11g"],
});

const RISK = riskAssessmentSchema.parse({
  ranked: [
    {
      serviceName: "OrderService",
      riskLevel: "critical",
      reasoning: "Schema coupling means the data model changes with every release.",
      evidenceSource: "logs",
    },
    {
      serviceName: "InventoryService",
      riskLevel: "low",
      reasoning: "Read paths are already thin.",
      evidenceSource: "static_analysis",
    },
  ],
  operationalDataAvailable: false,
});

function reportFor(findings: ScoringFinding[] = FINDINGS): AnalysisReportModel {
  const refined = recomputeScorecard({ input: { findings, dependencies: DEPENDENCIES } });

  const loaded: LoadedScorecard = {
    run: {
      id: "run-1",
      projectId: PROJECT.id,
      ownerId: "owner-1",
      status: "complete",
      step: "done",
      error: null,
      createdAt: new Date("2026-01-02T03:10:00.000Z"),
      completedAt: new Date("2026-01-02T03:12:00.000Z"),
      outputs: { discovery: null, architecture: null, risk: null, comparison: null },
    },
    input: refined.input,
    scorecard: refined.scorecard,
    explanation: refined.explanation,
    baseline: refined.baseline,
    outputs: { discovery: DISCOVERY, risk: RISK },
    refinement: {
      operational: refined.operational,
      adjustment: refined.adjustment,
      parameters: refined.parameters,
      parametersInForce: refined.parametersInForce,
      changed: refined.changed,
      description: describeRefinement(refined),
    },
  };

  return buildAnalysisReport({
    project: PROJECT,
    loaded,
    graph: buildDependencyGraph({
      services: loaded.input.findings,
      dependencies: loaded.input.dependencies,
    }),
    sources: {
      sources: [
        { source: "src/main/java/com/legacy/OrderService.java", documentType: "source", chunks: 12 },
      ],
      total: 2,
    },
  });
}

function renderReport(report: AnalysisReportModel = reportFor()) {
  return render(<AnalysisReport report={report} projectName={PROJECT.name} />);
}

/** The section disclosures, which are the ones without `open`. */
const sectionSummaries = (): HTMLElement[] =>
  Array.from(document.querySelectorAll("details > summary > h4")).map(
    (heading) => heading.closest("summary") as HTMLElement,
  );

describe("report rendering", () => {
  it("renders the report from the composed analysis", () => {
    renderReport();

    expect(screen.getByRole("heading", { level: 3, name: "Analysis Report" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: "Executive summary" })).toBeTruthy();
    // The Discovery summary is quoted in the executive summary and repeated as the
    // discovery section's own item, so presence is what is asserted.
    expect(screen.getAllByText(DISCOVERY.summary).length).toBeGreaterThan(0);
  });

  it("shows the executive summary and key findings without expanding anything", () => {
    renderReport();

    const findings = screen.getByRole("list", { name: "Key takeaways" });
    expect(findings.textContent).toContain("OrderService — critical risk");
    // The Risk stage's reasoning, not a restatement of the label.
    expect(findings.textContent).toContain(RISK.ranked[0]?.reasoning as string);
  });

  it("keeps the section bodies behind progressive disclosure", () => {
    renderReport();

    const summaries = sectionSummaries();
    expect(summaries.map((summary) => summary.querySelector("h4")?.textContent)).toEqual([
      "System Discovery",
      "Architecture Analysis",
      "Risk Analysis",
      "Findings by Service",
      "Migration Considerations",
      "Effort and Cost Explanation",
      "Evidence",
    ]);

    for (const summary of summaries) {
      const details = summary.closest("details") as HTMLDetailsElement;
      // Closed by default, and the summary is the control — native disclosure, so it
      // is keyboard-operable and works without JavaScript.
      expect(details.open).toBe(false);
      expect(summary.tagName).toBe("SUMMARY");
      // The collapsed state still says what the section holds.
      expect((summary.textContent ?? "").length).toBeGreaterThan(
        (summary.querySelector("h4")?.textContent ?? "").length,
      );
    }
  });

  it("states its own provenance in one secondary metadata line, from the sections' counts", () => {
    const report = reportFor();
    renderReport(report);

    const countIn = (sectionId: string, label: string): string =>
      report.sections
        .find((section) => section.id === sectionId)
        ?.counts.find((entry) => entry.label === label)?.value ?? "";

    const heading = screen.getByRole("heading", { level: 3, name: "Analysis Report" });
    const header = heading.closest("section") as HTMLElement;
    const meta = header.querySelector("p.meta") as HTMLElement | null;
    const line = meta?.textContent ?? "";

    // The numbers are the sections' own — nothing is counted a second time here…
    expect(line).toContain(`${countIn("risk", "Findings")} findings`);
    expect(line).toContain(`${countIn("discovery", "Dependency edges")} dependency edges`);
    expect(line).toContain(`${countIn("estimates", "Evidence quality")} evidence`);
    // …and the line is metadata, not a headline.
    expect(meta?.className).toContain("meta");
  });

  it("spans the dashboard while the prose keeps a readable measure", () => {
    const report = reportFor();
    renderReport(report);

    const section = screen
      .getByRole("heading", { level: 3, name: "Analysis Report" })
      .closest("section") as HTMLElement;

    const takeaways = screen.getByRole("list", { name: "Key takeaways" });
    // The container is *not* capped: an earlier version limited the report card to
    // 42rem, which left half the dashboard empty and made the report read as an
    // article embedded in the product rather than part of it.
    expect(section.className).not.toContain("report-doc");
    expect(section.className).not.toContain("document");

    // Readability is enforced on the text instead. The summary band splits into a
    // lede beside its supporting paragraphs on a wide screen…
    const summary = document.querySelector(".report-summary") as HTMLElement;
    expect(summary.className).toContain("grid");
    expect(summary.className).toContain("xl:grid-cols-");
    // …and every paragraph of it carries the measure class, as does prose elsewhere.
    expect(summary.querySelector(".report-lede")?.className).toContain("report-measure");
    expect(summary.querySelectorAll(".report-measure").length).toBeGreaterThan(1);
    const takeawayDetail = takeaways.querySelector(".report-prose") as HTMLElement;
    expect(takeawayDetail.className).toContain("report-measure");

    // The key takeaways are a grid rather than a single long column.
    expect(takeaways.className).toContain("grid");
    expect(takeaways.className).toContain("lg:grid-cols-2");
  });

  it("gives the opening paragraph of the summaries lead weight and the rest ordinary prose", () => {
    const report = reportFor();
    renderReport(report);

    // Only the summary prose: the takeaway rows hold paragraphs too, and they are
    // covered by their own tests.
    const summary = document.querySelector(".report-summary") as HTMLElement;
    const paragraphs = Array.from(summary.querySelectorAll("p"));

    const lede = paragraphs.find((p) => p.className.includes("report-lede"));
    expect(lede?.textContent).toBe(report.summaryParagraphs[0]);
    // Exactly one lead paragraph: the rest are the same prose at the same weight.
    expect(paragraphs.filter((p) => p.className.includes("report-lede"))).toHaveLength(1);
    expect(paragraphs.filter((p) => p.className.includes("report-prose")).length).toBe(
      report.summaryParagraphs.length - 1,
    );
  });

  it("keeps each finding's evidence one press away, counted, and still a named list", () => {
    renderReport();

    const takeaways = screen.getByRole("list", { name: "Key takeaways" });
    const first = takeaways.querySelector("li") as HTMLElement;
    const disclosure = first.querySelector("details") as HTMLDetailsElement;

    // Closed by default: a dozen static-analysis lines under every finding is the
    // wall of text the report is meant not to be.
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toContain("Evidence (");
    // …and the list keeps its accessible name once opened, so it is still a named
    // list for a screen reader rather than a run of text.
    const list = disclosure.querySelector("ul");
    expect(list?.getAttribute("aria-label")).toMatch(/^Evidence for /);
    expect(list?.querySelectorAll("li").length).toBeGreaterThan(0);
  });

  it("carries severity as a word with a decorative dot, not as a coloured pill", () => {
    renderReport();

    const findings = screen.getByRole("list", { name: "Key takeaways" });
    const first = findings.querySelector("li") as HTMLElement;
    const severity = first.querySelector("span") as HTMLElement;

    expect(severity.textContent).toBe("Critical");
    // The colour is on a dot that assistive technology ignores; the word is the
    // meaning, so nothing depends on hue.
    expect(severity.querySelector("span")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("presents each section as a navigation row rather than a bordered card", () => {
    renderReport();

    for (const summary of sectionSummaries()) {
      const details = summary.closest("details") as HTMLDetailsElement;
      // A hairline row, not a nested box…
      expect(details.className).toContain("row-disclosure");
      expect(details.className).not.toContain("border-[var(--border)]");
      // …whose chevron is decoration and whose heading stays a direct child.
      expect(summary.querySelector(".marker")?.getAttribute("aria-hidden")).toBe("true");
      expect(summary.querySelector(":scope > h4")).toBeTruthy();
    }
  });

  it("renders every section's findings, counts and severity in words", () => {
    renderReport();

    const riskDetails = screen
      .getByRole("heading", { level: 4, name: "Risk Analysis" })
      .closest("details") as HTMLDetailsElement;

    // The severity is text as well as colour: nothing is conveyed by hue alone.
    expect(riskDetails.textContent).toContain("Critical");
    expect(riskDetails.textContent).toContain("OrderService — critical");
    expect(riskDetails.textContent).toContain(RISK.ranked[0]?.reasoning as string);

    // Counts are a definition list, not a run of divs.
    const counts = riskDetails.querySelector("dl");
    expect(counts?.getAttribute("aria-label")).toBe("Risk Analysis counts");
    expect(Array.from(counts?.querySelectorAll("dt") ?? []).map((term) => term.textContent)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "Findings",
    ]);
  });

  it("lists each section's items with an accessible name", () => {
    renderReport();

    const discovery = screen.getByRole("list", { name: "System Discovery items" });
    const items = Array.from(discovery.querySelectorAll("li")).map((item) => item.textContent ?? "");

    expect(items.some((item) => item.includes("OrderService") && item.includes("critical risk"))).toBe(true);
    // Risk factors are cited as evidence under the service.
    expect(items.some((item) => item.includes("shared mutable schema"))).toBe(true);
  });

  it("renders the evidence section from the indexed source list", () => {
    renderReport();

    const evidence = screen
      .getByRole("heading", { level: 4, name: "Evidence" })
      .closest("details") as HTMLDetailsElement;

    expect(evidence.textContent).toContain("src/main/java/com/legacy/OrderService.java");
    expect(evidence.textContent).toContain("source · 12 chunks indexed");
    // An elision is stated, not silent.
    expect(evidence.textContent).toContain("1 of 2");
  });

  it("explains the estimates with the scorecard's own numbers", () => {
    const report = reportFor();
    renderReport(report);

    const estimates = screen
      .getByRole("heading", { level: 4, name: "Effort and Cost Explanation" })
      .closest("details") as HTMLDetailsElement;

    expect(estimates.textContent).toContain(report.sections.find((s) => s.id === "estimates")?.summary.slice(0, 30) as string);
    expect(estimates.textContent).toContain("Effort");
    expect(estimates.textContent).toContain("Cost");
    expect(estimates.textContent).toContain("Time");
  });
});

describe("findings by service", () => {
  it("expands each service on its own, named and with its severity in words", () => {
    renderReport();

    const list = screen.getByRole("list", { name: "Findings by Service items" });
    const rows = Array.from(list.children) as HTMLElement[];

    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("OrderService"),
        expect.stringContaining("InventoryService"),
      ]),
    );

    const orderRow = rows[0];
    // One disclosure per service, closed by default, with the summary carrying the
    // name, the severity word and the trait line — so the collapsed list is readable.
    const disclosure = orderRow?.querySelector("details") as HTMLDetailsElement;
    expect(disclosure.tagName).toBe("DETAILS");
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toContain("OrderService");
    expect(disclosure.querySelector("summary")?.textContent).toContain("Critical");
    expect(disclosure.querySelector("summary")?.textContent).toContain("critical risk");
  });

  it("keeps the evidence and the per-service question inside the service's disclosure", () => {
    renderReport();

    const list = screen.getByRole("list", { name: "Findings by Service items" });
    const orderRow = list.children[0] as HTMLElement;
    const evidence = orderRow.querySelector("ul[aria-label='Evidence for OrderService']");

    expect(evidence?.textContent).toContain("shared mutable schema");
    expect(evidence?.textContent).toContain("rubric level value 100/100");
    expect(orderRow.querySelector("button[aria-label='Ask about OrderService']")).toBeTruthy();
  });

  it("states that no findings exist, and still shows the services only the edges mention", () => {
    renderReport(reportFor([]));

    const section = screen
      .getByRole("heading", { level: 4, name: "Findings by Service" })
      .closest("details") as HTMLDetailsElement;

    expect(section.textContent).toContain("No service findings were persisted for this run");

    // The services in the edge list have no finding, which is exactly what is shown —
    // unrated, rather than omitted or given an invented severity.
    const rows = Array.from(
      screen.getByRole("list", { name: "Findings by Service items" }).children,
    ).map((row) => row.textContent ?? "");
    expect(rows.every((row) => row.includes("unrated"))).toBe(true);
    expect(rows.join(" | ")).toContain("OrderService");
  });

  it("renders the section's own empty note when there is nothing to group at all", () => {
    const empty = { ...reportFor([]), sections: [] };

    // A report with no sections at all renders its empty state instead; the note path
    // itself is covered by the composer's tests. Here the point is that the component
    // never renders an empty list box for a section without items.
    render(
      <AnalysisReport
        report={{
          ...empty,
          empty: false,
          summaryParagraphs: ["Nothing to explain."],
          highlights: [],
          sections: [
            {
              id: "service-findings",
              title: "Findings by Service",
              summary: "No service findings were persisted for this run.",
              counts: [],
              items: [],
              emptyNote: "No service findings were persisted for this run, so there is nothing to group by service.",
              ask: { question: "Which services have findings?", context: "Report · Findings by service" },
            },
          ],
        }}
        projectName={PROJECT.name}
      />,
    );

    const section = screen
      .getByRole("heading", { level: 4, name: "Findings by Service" })
      .closest("details") as HTMLDetailsElement;

    expect(section.textContent).toContain("nothing to group by service");
    expect(screen.queryByRole("list", { name: "Findings by Service items" })).toBeNull();
  });
});

describe("empty report state", () => {
  it("renders the reason as a status instead of empty sections", () => {
    const empty = reportFor([]);
    render(
      <AnalysisReport
        report={{ ...empty, empty: true, emptyReason: "Nothing was analysed in this run." }}
        projectName={PROJECT.name}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Nothing was analysed in this run.");
    expect(screen.queryByRole("list", { name: "Key takeaways" })).toBeNull();
    expect(document.querySelectorAll("details")).toHaveLength(0);
  });
});

describe("ask handoff", () => {
  const capture = (): AskHandoffRequest[] => {
    const received: AskHandoffRequest[] = [];
    window.addEventListener(ASK_HANDOFF_EVENT, (event) => {
      received.push((event as CustomEvent<AskHandoffRequest>).detail);
    });
    return received;
  };

  it("hands a section's question to the ask bar, with its context", () => {
    const received = capture();
    renderReport();

    fireEvent.click(screen.getByRole("button", { name: "Ask about Architecture Analysis" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.projectId).toBe(PROJECT.id);
    expect(received[0]?.question).toContain(PROJECT.name);
    expect(received[0]?.question).toContain("coupled");
    expect(received[0]?.context).toContain("Report · Architecture");
  });

  it("hands a single finding's question to the ask bar", () => {
    const received = capture();
    renderReport();

    fireEvent.click(screen.getByRole("button", { name: "Ask about OrderService — critical risk" }));

    expect(received).toHaveLength(1);
    expect(received[0]?.question).toBe(
      "Why is OrderService rated critical, and what evidence supports that rating?",
    );
    expect(received[0]?.context).toContain("Key finding");
  });

  it("gives every ask control its own accessible name", () => {
    renderReport();

    const controls = screen.getAllByRole("button", { name: /^Ask about / });
    const names = controls.map((control) => control.getAttribute("aria-label"));

    expect(names.length).toBeGreaterThan(6);
    expect(new Set(names).size).toBe(names.length);
  });
});
