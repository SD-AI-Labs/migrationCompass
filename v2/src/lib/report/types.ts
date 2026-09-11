/**
 * The Analysis Report's shape.
 *
 * The report is the explanation layer under the scorecard: the scorecard states
 * five numbers, and this states what was discovered, why the numbers are what they
 * are, and what the migration considerations are. It is **composed**, never
 * generated — every sentence traces back to a persisted structured output, a
 * persisted finding, the dependency graph, or the deterministic rubric, which is
 * the same credibility rule the scorecard follows.
 *
 * This module holds no runtime imports on purpose: the client component that
 * renders a report takes one of these as a prop, and it must not pull the scoring
 * or agent modules into the browser bundle to do it.
 */

export const REPORT_SECTION_IDS = [
  "executive-summary",
  "discovery",
  "architecture",
  "risk",
  "service-findings",
  "migration",
  "estimates",
  "evidence",
] as const;

export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number];

/**
 * How an item reads. Tone is stated in words by the renderer as well as in colour,
 * so a reader who cannot distinguish the palette loses nothing.
 */
export const REPORT_TONES = ["critical", "high", "medium", "low", "positive", "neutral"] as const;

export type ReportTone = (typeof REPORT_TONES)[number];

export type ReportItem = {
  id: string;
  /** The subject: a service, a metric, a phase, a file. */
  label: string;
  /** One sentence about it, composed from persisted values. */
  detail: string;
  tone: ReportTone;
  /** Short supporting facts — counts, rubric values, cited evidence strings. */
  evidence: string[];
  /** Present on finding-level items, so a single finding can be asked about. */
  ask?: ReportAsk;
};

export type ReportCount = { label: string; value: string };

/**
 * One indexed source file, as the evidence section lists it.
 *
 * Deliberately three fields and no content: the report cites *which* files were
 * analysed and what they were classified as, and never quotes the source. A path
 * is a reference; a chunk body is the user's code.
 */
export type IndexedSource = {
  source: string;
  documentType: string;
  chunks: number;
};

export type IndexedSourceListing = {
  /** The files listed in the report, sorted by path so the order is stable. */
  sources: IndexedSource[];
  /** Every distinct indexed file, which can exceed what is listed. */
  total: number;
};

/** What a section hands to the ask bar: the question, and what it was asked from. */
export type ReportAsk = {
  question: string;
  context: string;
};

export type ReportSection = {
  id: ReportSectionId;
  title: string;
  /** Always visible: one or two sentences, so the collapsed state is informative. */
  summary: string;
  counts: ReportCount[];
  items: ReportItem[];
  /** What the section says when it has nothing to report. Never an empty box. */
  emptyNote: string;
  ask: ReportAsk;
};

export type AnalysisReport = {
  projectId: string;
  runId: string;
  /**
   * True when the run produced no structured analysis output and no findings —
   * a run that predates the structured columns, or one that recorded nothing.
   */
  empty: boolean;
  /** Why the report is empty, in one sentence. */
  emptyReason: string;
  /** Paragraphs of the executive summary. Rendered without a disclosure. */
  summaryParagraphs: string[];
  /** The key findings, rendered with the summary rather than behind a section. */
  highlights: ReportItem[];
  /** Every section, in reading order, executive summary first. */
  sections: ReportSection[];
};
