import { RISK_LEVEL_VALUES, describeAssumptions } from "@/lib/scoring/assumptions";
import type { ScorecardExplanation, ScoreExplanation, ScoreName } from "@/lib/scoring/explain";
import { SCORE_NAMES, SCORE_LABELS, verifyContributions } from "@/lib/scoring/explain";
import { formatScoreValue, formatScorecardValue } from "@/lib/scoring/format";
import type { Scorecard as ScorecardModel } from "@/lib/scoring/rubric";

/**
 * The scorecard — Layer 1 of the continuous page.
 *
 * Three things it deliberately does:
 *
 * 1. **Shows the confidence tag next to every score.** Not once for the whole
 *    card: a reader scanning a number needs to know what it rests on there and
 *    then, not in a footnote.
 * 2. **Makes every score expandable into its arithmetic.** `<details>` rather than
 *    a click handler, so it works without JavaScript and expands in place — the
 *    plan's "never a destination change" rule applied to a disclosure.
 * 3. **Shows the assumptions in force.** Team size and weekly rate change the cost
 *    materially, and the plan is explicit that they are visible rather than hidden.
 *
 * The explanation comes from `explain.ts` — arithmetic over the same persisted
 * findings — so nothing here is generated text.
 *
 * Presentation, in one sentence: the number is the card. Each tile reads name →
 * ring → confidence → one truncated line of prose → "Why this number", and the
 * full explanation, the formula and the contribution table live inside that
 * disclosure. The prose is clipped with `line-clamp` and marked `aria-hidden`
 * rather than removed: the whole paragraph is rendered again at the top of the
 * expanded body, so a sighted reader gets three lines and then all of it, and a
 * screen reader is not read the same sentence twice.
 */

/** Evidence level, as text and colour — never colour alone. */
const EVIDENCE_TEXT: Record<string, string> = {
  strong: "text-[var(--risk-low)]",
  partial: "text-[var(--risk-medium)]",
  limited: "text-[var(--muted)]",
};

const PARAMETER_TONE: Record<string, string> = {
  over: "text-[var(--risk-high)]",
  within: "text-[var(--risk-low)]",
  noted: "text-[var(--muted)]",
  under: "text-[var(--muted)]",
  unset: "text-[var(--muted)]",
};

/** The separator between two pieces of metadata; decoration, so hidden from AT. */
function Dot() {
  return (
    <span aria-hidden className="text-[var(--border)]">
      ·
    </span>
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Effort's domain, as the rubric clamps it. Only used to scale the ring. */
const EFFORT_MIN = 1;
const EFFORT_MAX = 10;

/**
 * The range a score's ring is drawn against, or null where the rubric states none.
 *
 * Readiness and Risk are clamped to 0–100 and Effort to 1–10 by `rubric.ts`, so an
 * arc is a faithful picture of them. Cost and Time have no ceiling — a cost in
 * currency and a duration in weeks have no "full" — so they return null: the ring
 * draws no arc rather than a maximum invented to fill against, and the number
 * inside stays the whole statement. Nothing here computes a score.
 */
function ringFraction(score: ScoreName, value: number): number | null {
  switch (score) {
    case "readiness":
    case "risk":
      return clamp01(value / 100);
    case "effort":
      return clamp01((value - EFFORT_MIN) / (EFFORT_MAX - EFFORT_MIN));
    default:
      return null;
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The ring's colour. Risk is the one score where more is worse, so it takes the
 * documented level palette — the boundaries between the rubric's level values
 * (Low 25 / Medium 50 / High 75 / Critical 100) — and the others take the accent.
 * Presentation only; the number is the rubric's.
 */
function ringTone(score: ScoreName, value: number): string {
  if (score !== "risk") return "var(--accent)";

  const critical = (RISK_LEVEL_VALUES.critical + RISK_LEVEL_VALUES.high) / 2;
  const high = (RISK_LEVEL_VALUES.high + RISK_LEVEL_VALUES.medium) / 2;
  const medium = (RISK_LEVEL_VALUES.medium + RISK_LEVEL_VALUES.low) / 2;

  if (value >= critical) return "var(--risk-critical)";
  if (value >= high) return "var(--risk-high)";
  if (value >= medium) return "var(--risk-medium)";
  return "var(--risk-low)";
}

/**
 * The number inside the ring, and its unit.
 *
 * Cost drops the currency from the number and carries it as the unit so a long
 * figure still fits the circle; the accessible name below puts them back together.
 */
function ringReadout(explanation: ScoreExplanation): { value: string; unit: string } {
  if (explanation.score === "cost") {
    return { value: Math.round(explanation.value).toLocaleString("en-US"), unit: explanation.unit };
  }
  if (explanation.score === "time") {
    return { value: String(explanation.value), unit: explanation.unit };
  }
  return { value: explanation.value.toFixed(1), unit: explanation.unit };
}

/**
 * The score as a ring, with the number at its centre.
 *
 * The arc and the figure are one graphic: the wrapper carries the accessible name
 * (`Metric: value unit`) and everything inside it is decorative, so a screen reader
 * announces the score once, as a score, rather than reading a stray arc and an
 * unlabelled number. The explanatory content stays outside the ring — a circle is
 * for the one number it is about.
 */
function ScoreRing({
  score,
  value,
  fraction,
  readout,
  accessibleName,
}: {
  score: ScoreName;
  value: number;
  fraction: number | null;
  readout: { value: string; unit: string };
  accessibleName: string;
}) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const travelled = fraction === null ? 0 : fraction * circumference;

  return (
    <div role="img" aria-label={accessibleName} className="relative flex size-25 items-center justify-center">
      <svg viewBox="0 0 100 100" aria-hidden="true" className="size-full -rotate-90">
        <circle cx={50} cy={50} r={radius} fill="none" stroke="var(--border)" strokeWidth={8} />
        {fraction !== null && fraction > 0 && (
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke={ringTone(score, value)}
            strokeWidth={8}
            strokeLinecap="round"
            strokeDasharray={`${travelled} ${circumference - travelled}`}
          />
        )}
      </svg>

      <div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={`font-semibold tabular-nums leading-none ${
            readout.value.length > 7 ? "text-[15px]" : "text-[22px]"
          }`}
        >
          {readout.value}
        </span>
        <span className="mt-1 text-[10px] tracking-wide text-[var(--muted)] uppercase">
          {readout.unit}
        </span>
      </div>
    </div>
  );
}

/** What a refinement changed, narrowed to what the scorecard renders. */
export type RefinedInfo = {
  changed: boolean;
  description: string;
  reasons: string[];
  terms: { key: string; label: string; value: number; detail: string }[];
  parameters: { key: string; label: string; value: string; status: string; note: string }[];
};

/** The "Why this number" affordance, identical on every tile. */
function WhyThisNumber() {
  return (
    <span className="inline-flex items-center gap-1 pt-2 text-[11px] font-medium text-[var(--muted)] transition-colors group-hover:text-[var(--foreground)]">
      Why this number
      <span aria-hidden className="marker">
        ›
      </span>
    </span>
  );
}

function ScoreTile({
  explanation,
  evidenceLevel,
  confidenceLabel,
  baselineFormatted,
}: {
  explanation: ScoreExplanation;
  evidenceLevel: string;
  confidenceLabel: string;
  baselineFormatted?: string;
}) {
  // Checked here rather than asserted in a test only: if a decomposition ever
  // stops summing, the card says so instead of presenting a number nobody can
  // reproduce.
  const consistent = verifyContributions(explanation);
  const current = formatScoreValue(explanation);
  const moved = baselineFormatted !== undefined && baselineFormatted !== current;
  const readout = ringReadout(explanation);
  // Time is the one score whose headline value is a single figure derived from a
  // band, so the band is shown with it — the point of the estimate was the range.
  const range = explanation.score === "time" ? explanation.formatted : null;

  return (
    <details className="tile group flex h-full min-w-0 flex-col p-4">
      {/* `flex-1` on the summary, with the confidence row pushed down by `mt-auto`:
          the tiles have different amounts of clipped prose, and without this the
          confidence and "Why this number" lines land at a different height on every
          card — which is exactly the raggedness a six-across dashboard cannot afford. */}
      <summary className="flex flex-1 cursor-pointer list-none flex-col items-center">
        <p className="eyebrow text-center">{SCORE_LABELS[explanation.score]}</p>

        <div className="mt-4 flex justify-center">
          <ScoreRing
            score={explanation.score}
            value={explanation.value}
            fraction={ringFraction(explanation.score, explanation.value)}
            readout={readout}
            accessibleName={`${SCORE_LABELS[explanation.score]}: ${readout.value} ${readout.unit}`}
          />
        </div>

        {range && <p className="meta mt-2 text-center tabular-nums">{range}</p>}
        {moved && (
          <p className="meta text-center tabular-nums">was {baselineFormatted}</p>
        )}

        {/* Visually clipped, and hidden from assistive technology *because* it is a
            clip: the full sentence is the first thing in the expanded body below. */}
        <p
          aria-hidden="true"
          className="mt-3 line-clamp-2 text-center text-[11.5px] leading-snug text-[var(--muted)]"
        >
          {explanation.summary}
        </p>

        <p className="mt-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-3 text-[11px]">
          <span className="text-[var(--foreground)]">{confidenceLabel}</span>
          <Dot />
          <span className={EVIDENCE_TEXT[evidenceLevel] ?? EVIDENCE_TEXT.limited}>
            {evidenceLevel} evidence
          </span>
        </p>

        <WhyThisNumber />
      </summary>

      <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
        <p className="eyebrow">Why this number</p>
        <p className="report-prose mt-2 text-[13px]">{explanation.summary}</p>
        <p className="meta mt-2 font-mono break-words">{explanation.formula}</p>

        {explanation.contributions.length > 0 && (
          <ul className="mt-3">
            {explanation.contributions.map((contribution) => (
              <li
                key={contribution.key}
                className="border-b border-[var(--border-subtle)] py-1.5 last:border-b-0"
              >
                <p className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="text-[var(--foreground)]">{contribution.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {contribution.value >= 0 ? "+" : ""}
                    {contribution.value.toFixed(2)}
                  </span>
                </p>
                <p className="text-[11px] text-[var(--muted)]">{contribution.detail}</p>
              </li>
            ))}
            <li className="py-1.5">
              <p className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="text-[var(--muted)]">Total</span>
                <span className="shrink-0 tabular-nums">{explanation.total.toFixed(2)}</span>
              </p>
              <p className="text-[11px] text-[var(--muted)]">
                {explanation.additive
                  ? consistent
                    ? "contributions sum to the score"
                    : "contributions do NOT sum to the score — treat this value as unreliable"
                  : "multiplicative: shown as factors, not a sum"}
              </p>
            </li>
          </ul>
        )}

        {explanation.factors.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1">
            {explanation.factors.map((factor) => (
              <li key={factor.label} className="text-[12px]">
                <span className="text-[var(--foreground)]">{factor.label}:</span>{" "}
                <span className="tabular-nums">{factor.value}</span>{" "}
                <span className="text-[var(--muted)]">— {factor.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * The sixth metric.
 *
 * The assumptions are not a score, so they get no arc — an invented ring for a team
 * size would say more about the drawing than about the estimate. What they do get
 * is the same tile, the same type scale and the same disclosure, so the row of six
 * reads as one scorecard: five numbers and the basis they rest on.
 */
function AssumptionsTile({ scorecard, explanation }: { scorecard: ScorecardModel; explanation: ScorecardExplanation }) {
  return (
    <details className="tile group flex h-full min-w-0 flex-col p-4">
      <summary className="flex flex-1 cursor-pointer list-none flex-col items-center">
        <p className="eyebrow text-center">Assumptions</p>

        <p className="mt-7 text-center text-[22px] font-semibold leading-none tabular-nums">
          {scorecard.assumptions.teamSize} × {scorecard.assumptions.currency}{" "}
          {scorecard.assumptions.weeklyRate.toLocaleString("en-US")}
        </p>
        <p className="meta mt-2 text-center">engineers × blended weekly rate</p>

        <p
          aria-hidden="true"
          className="mt-3 line-clamp-2 text-center text-[11.5px] leading-snug text-[var(--muted)]"
        >
          Team size and blended weekly rate driving the cost estimate — shown, not hidden.
        </p>
        <span aria-hidden className="mt-auto" />

        <WhyThisNumber />
      </summary>

      <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
        <p className="eyebrow">In force for this estimate</p>
        <ul className="mt-2">
          {describeAssumptions(explanation.assumptions).map((line) => (
            <li key={line.label} className="border-b border-[var(--border-subtle)] py-2 last:border-b-0">
              <p className="text-[12px]">
                <span className="text-[var(--foreground)]">{line.label}:</span>{" "}
                <span className="tabular-nums">{line.value}</span>
              </p>
              <p className="text-[11px] text-[var(--muted)]">{line.note}</p>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function Scorecard({
  scorecard,
  explanation,
  baseline,
  refinement,
}: {
  scorecard: ScorecardModel;
  explanation: ScorecardExplanation;
  /** The code-only scorecard, when this one has been refined. */
  baseline?: ScorecardModel;
  /** What the refinement changed, and why. */
  refinement?: RefinedInfo;
}) {
  const refined = refinement?.changed === true;
  const movement = baseline ? round1(scorecard.risk - baseline.risk) : 0;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-[22px] font-semibold tracking-tight">Scorecard</h3>
          <p className="caption mt-1.5">Five computed scores and the assumptions they rest on</p>
        </div>
        <p className="meta lg:text-right">
          computed from {scorecard.counts.services} service findings · {scorecard.counts.dependencies}{" "}
          dependency edges · {scorecard.counts.phases} migration phases
        </p>
      </div>

      {/* The distinction the plan insists on, stated once, prominently, in the two
          vocabularies it uses: an estimate from code alone, or one refined with
          measured operational data. Neither is model-generated, and saying so is the
          whole credibility argument for the scorecard. */}
      <p className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
        <span className="chip-accent">{scorecard.confidence.label}</span>
        <span className="max-w-[46rem] text-[var(--muted)]">
          {refined
            ? `measured operational data moved Risk ${movement > 0 ? "+" : ""}${movement.toFixed(1)} points. The narrative findings are unchanged.`
            : "computed from the persisted findings by the rubric — no model generates these numbers. Refine them with measured operational data below."}
        </span>
      </p>

      {/* Six metrics — the five scored ones and the assumptions they rest on — in one
          row once the viewport can carry them, dropping to three, two, then one as it
          narrows. Each cell is `min-w-0` and the ring is a fixed 100px, so nothing
          here can force a horizontal scrollbar. */}
      <ul
        aria-label="Primary metrics"
        className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
      >
        {SCORE_NAMES.map((name) => (
          <li key={name} className="min-w-0">
            <ScoreTile
              explanation={explanation.scores[name]}
              evidenceLevel={explanation.evidence.level}
              confidenceLabel={explanation.confidenceLabel}
              baselineFormatted={baseline ? formatScorecardValue(name, baseline) : undefined}
            />
          </li>
        ))}

        <li className="min-w-0">
          <AssumptionsTile scorecard={scorecard} explanation={explanation} />
        </li>
      </ul>

      {/* The rest of the card is a small stack of disclosures behind hairlines —
          secondary material, reachable, and quiet until asked for. */}
      <div className="mt-6 flex flex-col">
        <details className="row-disclosure">
          <summary>
            <span className="text-[13px] text-[var(--muted)]">
              Evidence quality: {explanation.evidence.label}
            </span>
            <span aria-hidden className="marker">
              ›
            </span>
          </summary>
          <ul className="mb-3 list-disc pl-5 text-[12px] text-[var(--muted)]">
            {explanation.evidence.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>

        {refinement && refinement.changed && (
          <details open className="row-disclosure">
            <summary>
              <span className="text-[13px]">What the operational data changed</span>
              <span aria-hidden className="marker">
                ›
              </span>
            </summary>
            <div className="mb-3">
              <p className="caption measure">{refinement.description}</p>

              {refinement.terms.length > 0 && (
                <ul className="mt-3">
                  {refinement.terms.map((term) => (
                    <li
                      key={term.key}
                      className="border-b border-[var(--border-subtle)] py-1.5 last:border-b-0"
                    >
                      <p className="flex items-baseline justify-between gap-2 text-[12px]">
                        <span className="text-[var(--foreground)]">{term.label}</span>
                        <span className="shrink-0 tabular-nums">
                          {term.value >= 0 ? "+" : ""}
                          {term.value.toFixed(2)}
                        </span>
                      </p>
                      <p className="text-[11px] text-[var(--muted)]">{term.detail}</p>
                    </li>
                  ))}
                </ul>
              )}

              <ul className="mt-3 list-disc pl-5 text-[11px] text-[var(--muted)]">
                {refinement.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>

              <p className="meta mt-3">
                Parsed deterministically from the supplied files — no model was called, and no finding was
                regenerated.
              </p>
            </div>
          </details>
        )}

        {refinement && refinement.parameters.length > 0 && (
          <details className="row-disclosure">
            <summary>
              <span className="text-[13px]">Migration parameters in force</span>
              <span aria-hidden className="marker">
                ›
              </span>
            </summary>
            <ul className="mb-3">
              {refinement.parameters.map((assessment) => (
                <li key={assessment.key} className="border-b border-[var(--border-subtle)] py-2 last:border-b-0">
                  <p className="text-[12px]">
                    <span className="text-[var(--foreground)]">{assessment.label}:</span>{" "}
                    <span className={`tabular-nums ${PARAMETER_TONE[assessment.status] ?? ""}`}>
                      {assessment.value}
                    </span>
                  </p>
                  <p className="text-[11px] text-[var(--muted)]">{assessment.note}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
