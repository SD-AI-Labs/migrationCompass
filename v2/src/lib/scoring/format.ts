import type { ScoreExplanation, ScoreName } from "./explain";
import type { Scorecard } from "./rubric";

/**
 * How a score reads, in one place.
 *
 * The scorecard's tiles and the analysis report both state the same five numbers,
 * and two formatters would eventually disagree — the report says "USD 711,000"
 * while the card says "711,000 USD", and a reader is left comparing strings
 * instead of values. Both now call these, so a consistency test can assert the
 * report's figures are literally the scorecard's.
 *
 * Nothing here computes anything: each function formats a value the rubric already
 * produced.
 */

/** A score from its explanation — the form the tiles and the report both hold. */
export function formatScoreValue(explanation: ScoreExplanation): string {
  if (explanation.score === "cost") {
    return `${explanation.unit} ${Math.round(explanation.value).toLocaleString("en-US")}`;
  }
  if (explanation.score === "time") {
    return `${explanation.value} weeks`;
  }
  return `${explanation.value.toFixed(1)} ${explanation.unit}`;
}

/** The same formatting, from the scorecard model — so a "was X" comparison lines up. */
export function formatScorecardValue(name: ScoreName, card: Scorecard): string {
  switch (name) {
    case "cost":
      return `${card.assumptions.currency} ${Math.round(card.cost).toLocaleString("en-US")}`;
    case "time":
      return `${card.time.weeksMid} weeks`;
    case "effort":
      return `${card.effort.toFixed(1)} / 10`;
    case "readiness":
      return `${card.readiness.toFixed(1)} / 100`;
    case "risk":
      return `${card.risk.toFixed(1)} / 100`;
    default:
      return "";
  }
}
