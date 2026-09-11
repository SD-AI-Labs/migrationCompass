"use client";

import type {
  AnalysisReport as AnalysisReportModel,
  ReportItem,
  ReportSection,
  ReportTone,
} from "@/lib/report/types";
import { requestAsk } from "@/lib/ask-handoff";

/**
 * The Analysis Report — the narrative half of the assessment, under the scorecard.
 *
 * It answers four questions in order, which is what the layout is for: **what did
 * the analysis find** (the executive summary and the key takeaways), **why does it
 * matter** (each section's summary line, visible while collapsed), **what is the
 * migration impact** (the migration and estimate sections), and **what evidence
 * supports it** (the evidence section, deliberately the quietest thing on the page).
 *
 * Structure follows the plan's progressive-disclosure rule rather than a new
 * destination: the executive summary and the key takeaways are always on screen (the
 * fast path), and each section is a `<details>` that expands in place (the deep
 * path). Nothing here navigates, and `<details>`/`<summary>` is the disclosure
 * control — native, keyboard-operable, and correct without JavaScript.
 *
 * It is a client component for one reason only: the "Ask about this" controls
 * publish a question to the ask bar, and that needs a click handler. The report
 * itself arrives as a prop — composed on the server by `buildAnalysisReport()` —
 * so no analysis logic is in the browser bundle.
 *
 * Reading aids, deliberately:
 *
 * - every item states its severity in words as well as colour, so nothing is
 *   conveyed by colour alone;
 * - counts are a definition list, items are lists with accessible names, and the
 *   section headings are real headings inside their summaries;
 * - an empty section says why it is empty rather than rendering an empty box.
 *
 * Composition: the report is a **chapter of the assessment surface**, not a document
 * embedded in it. Its container spans the dashboard and every band inside uses that
 * width — the executive summary in two prose columns, the key takeaways as a two-up
 * grid of compact cards, the findings as rows with their evidence alongside — while
 * the readability comes from `.report-measure` on the prose itself. An earlier pass
 * capped the *container* instead, which produced a narrow article floating in an
 * empty dashboard; that is the mistake this layout exists to avoid.
 *
 * The masthead rule (hairline plus accent segment) is what marks it as a new chapter
 * after the scorecard, so the two halves of the assessment read as one product.
 *
 * What this deliberately does **not** do: subdivide the executive summary into
 * labelled blocks ("overall assessment", "highest risk", "migration direction").
 * The builder returns that content as an ordered list of paragraphs with no labels,
 * and assigning them by position in the UI would be inventing a structure the data
 * does not carry — so the first paragraph is given lead weight and the rest follow,
 * and the structured part of the executive summary (the key takeaways) is presented
 * as exactly that. The scorecard explains the numbers; this report explains the
 * assessment, and the two stay in their own lanes.
 */

/** The word that accompanies the colour. Nothing carries meaning by hue alone. */
const TONE_WORDS: Record<ReportTone, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  positive: "Positive",
  neutral: "Note",
};

const TONE_TEXT: Record<ReportTone, string> = {
  critical: "text-[var(--risk-critical)]",
  high: "text-[var(--risk-high)]",
  medium: "text-[var(--risk-medium)]",
  low: "text-[var(--risk-low)]",
  positive: "text-[var(--risk-low)]",
  neutral: "text-[var(--muted)]",
};

const TONE_DOTS: Record<ReportTone, string> = {
  critical: "bg-[var(--risk-critical)]",
  high: "bg-[var(--risk-high)]",
  medium: "bg-[var(--risk-medium)]",
  low: "bg-[var(--risk-low)]",
  positive: "bg-[var(--risk-low)]",
  neutral: "bg-[var(--risk-unknown)]",
};

/** The measure for long-form prose and for the detail line under a finding. */
const MEASURE = "report-measure";
/** A section's one-line descriptor: wider than prose, narrower than the container. */
const DESCRIPTOR = "max-w-[58rem]";

/**
 * Severity, as a dot and a word.
 *
 * It was a bordered uppercase pill; at one pill per finding the border did the
 * shouting and the word did none of it. The dot carries the colour, the word
 * carries the meaning, and neither is load-bearing on its own.
 */
function Severity({ tone }: { tone: ReportTone }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[10.5px] font-semibold tracking-wider uppercase">
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${TONE_DOTS[tone]}`} />
      <span className={TONE_TEXT[tone]}>{TONE_WORDS[tone]}</span>
    </span>
  );
}

function AskControl({
  label,
  onAsk,
  className = "",
}: {
  label: string;
  onAsk: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onAsk}
      // The visible text is the same on every control, so the accessible name has to
      // carry the subject: a screen-reader user otherwise hears "Ask about this"
      // twenty times with no way to tell them apart.
      aria-label={`Ask about ${label}`}
      className={`btn btn-ghost ${className}`}
    >
      Ask about this
    </button>
  );
}

/**
 * The cited evidence under an item.
 *
 * Behind a disclosure, and counted, because a finding's evidence can be a dozen
 * lines of static-analysis facts: expanded by default it turns a scannable list of
 * findings into a wall of them, which is exactly what the report should not be. The
 * list keeps its accessible name, so it is still a named list once opened, and the
 * count in the summary says how much is behind it.
 */
function EvidenceList({ label, lines }: { label: string; lines: string[] }) {
  if (lines.length === 0) return null;

  return (
    <details className="min-w-0">
      <summary className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--muted)] transition-colors hover:text-[var(--accent)]">
        Evidence <span className="tabular-nums">({lines.length})</span>
        <span aria-hidden className="marker">
          ›
        </span>
      </summary>
      <ul
        aria-label={`Evidence for ${label}`}
        className="mt-2 flex flex-col gap-1 border-l border-[var(--border-subtle)] pl-3"
      >
        {lines.map((line) => (
          <li key={line} className="text-[11.5px] leading-relaxed text-[var(--muted)] break-words">
            {line}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Ask({ item, projectId }: { item: ReportItem; projectId: string }) {
  if (!item.ask) return null;

  return (
    <AskControl
      label={item.label}
      onAsk={() =>
        requestAsk({
          projectId,
          question: item.ask?.question ?? "",
          context: item.ask?.context ?? "",
        })
      }
    />
  );
}

/**
 * A key takeaway.
 *
 * The scan-first block of the report, so it gets a raised card: severity, the
 * finding as the owner of the card, one line of reasoning, and then its evidence and
 * Ask control on a single footer row. Two of these sit side by side on a wide screen,
 * which is what keeps the top of the report from being a long thin list.
 */
function TakeawayCard({ item, projectId }: { item: ReportItem; projectId: string }) {
  return (
    <li className="tile flex flex-col p-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Severity tone={item.tone} />
        <p className="text-[14px] font-medium text-[var(--foreground)]">{item.label}</p>
      </div>
      <p className={`report-prose mt-2 ${MEASURE}`}>{item.detail}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-4">
        <EvidenceList label={item.label} lines={item.evidence} />
        <Ask item={item} projectId={projectId} />
      </div>
    </li>
  );
}

/**
 * One item inside a section.
 *
 * `collapsible` is used for the per-service findings: a codebase can have dozens of
 * services, and one disclosure per service keeps the section scannable by name while
 * the facts stay one press away. Everything else renders in place, because a list of
 * five short rows does not need a second level of clicking.
 *
 * `compact` is used by the evidence section, which is supporting material: same
 * structure, less visual weight.
 *
 * On a wide screen the row splits: the finding on the left, its evidence and Ask
 * control in a narrow column on the right. That is how the finding list uses the
 * dashboard width without stretching a sentence across it.
 */
function ReportItemRow({
  item,
  projectId,
  collapsible = false,
  compact = false,
}: {
  item: ReportItem;
  projectId: string;
  collapsible?: boolean;
  compact?: boolean;
}) {
  if (collapsible) {
    return (
      <li className="border-b border-[var(--border-subtle)] last:border-b-0">
        <details>
          <summary className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-3">
            <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Severity tone={item.tone} />
              <span className="text-[14px] font-medium text-[var(--foreground)]">{item.label}</span>
            </span>
            <span aria-hidden className="marker col-start-2 row-span-2 self-center">
              ›
            </span>
            <span className={`meta col-start-1 min-w-0 ${DESCRIPTOR}`}>{item.detail}</span>
          </summary>
          <div className="flex flex-col items-start gap-2 pb-5 xl:ml-auto xl:w-[18rem] xl:items-end">
            <EvidenceList label={item.label} lines={item.evidence} />
            <Ask item={item} projectId={projectId} />
          </div>
        </details>
      </li>
    );
  }

  return (
    <li className="grid grid-cols-1 gap-x-10 gap-y-3 border-b border-[var(--border-subtle)] py-4 last:border-b-0 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Severity tone={item.tone} />
          <p
            className={`font-medium text-[var(--foreground)] ${
              compact ? "text-[13px]" : "text-[14px]"
            }`}
          >
            {item.label}
          </p>
        </div>
        <p className={`report-prose mt-2 ${MEASURE} ${compact ? "text-[12.5px]" : ""}`}>
          {item.detail}
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 xl:items-end">
        <EvidenceList label={item.label} lines={item.evidence} />
        <Ask item={item} projectId={projectId} />
      </div>
    </li>
  );
}

function Counts({ section }: { section: ReportSection }) {
  if (section.counts.length === 0) return null;

  return (
    <dl
      aria-label={`${section.title} counts`}
      className="grid max-w-[54rem] grid-cols-2 gap-x-8 gap-y-3 border-b border-[var(--border-subtle)] pb-5 sm:grid-cols-3 lg:grid-cols-5"
    >
      {section.counts.map((entry) => (
        <div key={entry.label} className="min-w-0">
          <dt className="eyebrow">{entry.label}</dt>
          <dd className="mt-1 truncate text-[15px] tabular-nums" title={entry.value}>
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SectionBody({ section, projectId }: { section: ReportSection; projectId: string }) {
  // Per-service findings get a disclosure per service: the list is bounded by the size
  // of the codebase, and a section that could hold forty services should be scannable
  // by name without expanding everything.
  const collapsibleItems = section.id === "service-findings";
  // Evidence is supporting material: same rows, less weight — it should never
  // compete with the findings it supports.
  const compact = section.id === "evidence";

  return (
    <div className="pb-8 pt-5">
      <Counts section={section} />

      {section.items.length > 0 ? (
        <ul aria-label={`${section.title} items`} className="mt-2">
          {section.items.map((item) => (
            <ReportItemRow
              key={item.id}
              item={item}
              projectId={projectId}
              collapsible={collapsibleItems}
              compact={compact}
            />
          ))}
        </ul>
      ) : (
        <p className="note mt-5">{section.emptyNote}</p>
      )}

      <div className="mt-4 flex justify-end">
        <AskControl
          label={section.title}
          onAsk={() =>
            requestAsk({
              projectId,
              question: section.ask.question,
              context: section.ask.context,
            })
          }
        />
      </div>
    </div>
  );
}

/**
 * The report's byline, assembled from the sections' own counts.
 *
 * Nothing is computed here that the analysis did not already state: a label that is
 * absent from every section is simply left out, so the line says what the run
 * recorded rather than a number invented to fill it.
 */
function statLine(report: AnalysisReportModel): string {
  const count = (label: string): string | undefined => {
    for (const section of report.sections) {
      const entry = section.counts.find((candidate) => candidate.label === label);
      if (entry) return entry.value;
    }
    return undefined;
  };

  const parts: string[] = [];
  const findings = count("Findings");
  const edges = count("Dependency edges");
  const files = count("Indexed files");
  const evidence = count("Evidence quality");

  if (findings) parts.push(`${findings} findings`);
  if (edges) parts.push(`${edges} dependency edges`);
  if (files) parts.push(`${files} indexed files`);
  if (evidence) parts.push(`${evidence} evidence`);

  return parts.join(" · ");
}

export function AnalysisReport({
  report,
  projectName,
}: {
  report: AnalysisReportModel;
  /** The project's name, for the empty state's sentence and the ask questions. */
  projectName: string;
}) {
  const sections = report.sections.filter((section) => section.id !== "executive-summary");
  const stats = statLine(report);
  const [lede, ...supporting] = report.summaryParagraphs;

  return (
    // Full width: the report is a chapter of the assessment, not an article floating
    // inside it. Readability is enforced by `.report-measure` on the prose.
    <section aria-labelledby="analysis-report-heading" className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-2">
        <div className="min-w-0">
          <h3 id="analysis-report-heading" className="text-[22px] font-semibold tracking-tight">
            Analysis Report
          </h3>
          <p className="caption mt-1.5">Migration assessment and supporting evidence</p>
        </div>
        {stats.length > 0 && (
          <p className="meta lg:max-w-[32rem] lg:text-right">{stats}</p>
        )}
      </div>

      <div aria-hidden className="masthead-rule mt-5" />

      {report.empty ? (
        <p role="status" className="note mt-6">
          {report.emptyReason}
        </p>
      ) : (
        <>
          {/* The assessment in one breath, then the supporting paragraphs beside it.
              An explicit split rather than CSS multi-column: the lede is the one thing
              a reader should read, the rest is what they read if they want it, and the
              two sit side by side so the band uses the dashboard width without any line
              exceeding a readable measure. */}
          <div className="mt-7">
            <h4 className="text-[15px] font-medium">Executive summary</h4>
            <div
              className={`report-summary mt-3 grid grid-cols-1 gap-x-14 gap-y-4 ${
                // Two columns only when there is something to put in the second one: a
                // run that produced a single paragraph should not render half a band of
                // empty space where its companion would have been.
                supporting.length > 0 ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""
              }`}
            >
              {lede && <p className="report-lede report-measure">{lede}</p>}
              {supporting.length > 0 && (
                <div className="report-measure flex flex-col">
                  {supporting.map((paragraph) => (
                    <p key={paragraph} className="report-prose">
                      {paragraph}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* The scan-first block: the highlighted findings as a two-up grid. */}
          <div className="mt-10">
            <h5 className="eyebrow">Key takeaways</h5>
            {report.highlights.length > 0 ? (
              <ul aria-label="Key takeaways" className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
                {report.highlights.map((item) => (
                  <TakeawayCard key={item.id} item={item} projectId={report.projectId} />
                ))}
              </ul>
            ) : (
              <p className="note mt-3">
                No critical, high, restructuring or coverage findings were recorded for {projectName}.
              </p>
            )}
          </div>

          {/* The detailed sections, as navigation rows: title and one-line summary
              while collapsed, the body in place when opened. */}
          <div className="mt-12 flex flex-col">
            {sections.map((section) => (
              <details key={section.id} className="row-disclosure">
                {/* A grid rather than a wrapper div: the section heading has to stay a
                    direct child of the summary, both for the heading order and so the
                    title remains the summary's own content. */}
                <summary className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6">
                  <h4 className="text-[15px] font-medium">{section.title}</h4>
                  <span aria-hidden className="marker col-start-2 row-span-2 self-center">
                    ›
                  </span>
                  <p className={`meta col-start-1 ${DESCRIPTOR}`}>{section.summary}</p>
                </summary>
                <SectionBody section={section} projectId={report.projectId} />
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
