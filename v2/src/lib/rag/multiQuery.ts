import type { LlmClient } from "@/lib/llm/client";

/**
 * Multi-query expansion — carried forward from V1's advanced RAG round.
 *
 * Why it earns its extra LLM call: a person's question ("why does the loyalty
 * stuff break so often?") shares almost no vocabulary with the source it should
 * retrieve (`recalculateLoyaltyPoints`, `CustomerAccountSessionBean`). One
 * embedding of one phrasing lands in one neighbourhood. Three diverse rephrasings
 * cast three nets, and the union retrieves chunks a single query never surfaces.
 *
 * Two design rules that are not obvious:
 *
 * 1. **The original question is always query #1.** Expansion is a recall
 *    improvement, not a replacement — if the model drifts, the user's literal
 *    question must still be searched.
 * 2. **Failure degrades to a single-query search, it does not fail.** A
 *    retrieval pipeline that returns nothing because a model call timed out is
 *    worse than one that returns the obvious results. `expandQuery` therefore
 *    never throws for model/parse problems.
 */

export const DEFAULT_QUERY_COUNT = 3;

/** Markers stripped from a model's numbered or bulleted list. */
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s*/;
/** Answers wrapped in quotes or bold markers, which models add unbidden. */
const WRAPPING = /^["'`*_]+|["'`*_]+$/g;
/**
 * A model that refuses, apologises, or asks for clarification returns prose, and
 * that prose is not a query. The line-length filter alone would let a short
 * sentence like "I can't help with that." through, so refusals are matched
 * explicitly.
 */
const REFUSAL = /\b(i'?m sorry|i am sorry|i can'?t|i cannot|i am unable|as an ai|please provide|without more context)\b/i;
const PREAMBLE = /^(i\b|i'?m\b|i am\b|sorry\b|sure\b|here\b|certainly\b|note\b|based on\b)/i;

/**
 * Extracts query variants from a model response. Pure and exported so the
 * parsing edge cases (preambles, numbering, duplicates, code fences) are tested
 * directly instead of through a model call.
 */
export function parseVariants(response: string | null, max: number): string[] {
  if (!response) return [];

  const variants: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.replace(LIST_MARKER, "").replace(WRAPPING, "").trim();

    // Too short to be a question; too long to be a query (a paragraph is the
    // model explaining instead of answering); trailing colon is a preamble like
    // "Here are three variants:".
    if (line.length < 8 || line.length > 300) continue;
    if (line.endsWith(":")) continue;
    if (line.startsWith("```")) continue;
    if (REFUSAL.test(line) || PREAMBLE.test(line)) continue;

    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(line);

    if (variants.length >= max) break;
  }

  return variants;
}

/**
 * Returns the queries to run: the original first, then up to `count - 1`
 * variants. Never fewer than one query, never throws.
 */
export async function expandQuery(
  question: string,
  llm: LlmClient,
  options: { count?: number } = {},
): Promise<string[]> {
  const count = Math.max(1, options.count ?? DEFAULT_QUERY_COUNT);
  if (count === 1) return [question];

  const response = await llm
    .complete({
      system:
        "You rewrite a question about a codebase into alternative search queries. " +
        "Reply with only the rewritten queries, one per line, no numbering, no commentary.",
      user:
        `Rewrite the following question into ${count - 1} alternative queries that are ` +
        `semantically diverse from each other and from the original — different phrasings, ` +
        `different angles, and where relevant different vocabulary (a developer's words ` +
        `vs. the words that would appear in source code).\n\n` +
        `Question: ${question}`,
      temperature: 0.4,
    })
    .catch(() => null);

  const variants = parseVariants(response, count - 1);

  // De-duplicate against the original too: a model asked to rephrase will
  // sometimes return the question verbatim, and searching the same query twice
  // buys nothing while doubling the retrieval cost.
  const queries = [question];
  const seen = new Set([question.trim().toLowerCase()]);
  for (const variant of variants) {
    if (seen.has(variant.toLowerCase())) continue;
    seen.add(variant.toLowerCase());
    queries.push(variant);
  }

  return queries;
}
