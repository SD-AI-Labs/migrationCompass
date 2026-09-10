import type { LlmClient } from "@/lib/llm/client";

/**
 * LLM reranking — carried forward from V1.
 *
 * Multi-query expansion is a recall strategy, and recall strategies make the
 * context window noisier: three retrievals means three times the candidates,
 * with duplicates and near-misses. This step is what turns that into a *better*
 * context window rather than a bigger one. Without it, expansion actively hurts.
 *
 * Two behaviours are load-bearing and both are tested:
 *
 * 1. **Fail open.** If the model errors or returns something unparseable, the
 *    caller gets the original candidates back, in their original order. Reranking
 *    is a quality improvement; it must not become a single point of failure for
 *    the whole ask path.
 * 2. **No call when there is nothing to rank.** If the candidate set already
 *    fits, ranking cannot change which chunks are used — only the order within
 *    them, which the prompt does not depend on. Skipping the call saves a model
 *    round-trip on every simple question.
 */

const NUMBER = /\d+/g;

/**
 * Parses a 1-based ranked list ("3,1,7") into 0-based indices.
 * Returns null when nothing usable was found — the signal to fail open.
 */
export function parseRanking(
  response: string | null,
  candidateCount: number,
  keepTop: number,
): number[] | null {
  if (!response) return null;

  const ranked: number[] = [];
  const seen = new Set<number>();

  for (const match of response.matchAll(NUMBER)) {
    const oneBased = Number.parseInt(match[0], 10);
    const zeroBased = oneBased - 1;
    if (zeroBased < 0 || zeroBased >= candidateCount) continue;
    if (seen.has(zeroBased)) continue;
    seen.add(zeroBased);
    ranked.push(zeroBased);
    if (ranked.length >= keepTop) break;
  }

  return ranked.length === 0 ? null : ranked;
}

export type RankableCandidate = {
  /** Stable identity, used to de-duplicate across retrievals before ranking. */
  id: string;
  /** Where the chunk came from, shown to the model so it can judge relevance. */
  source: string;
  content: string;
};

export type RerankOptions = {
  question: string;
  candidates: RankableCandidate[];
  keepTop: number;
  llm: LlmClient;
};

/**
 * Orders candidates by relevance and truncates to `keepTop`.
 *
 * Reranking never drops an item silently on failure: a failed rerank returns the
 * original list intact (not truncated to keepTop), because truncating by
 * retrieval order would be pretending to a judgment that was never made.
 */
export async function rerankCandidates({
  question,
  candidates,
  keepTop,
  llm,
}: RerankOptions): Promise<RankableCandidate[]> {
  if (candidates.length <= keepTop) return candidates;

  const numbered = candidates
    .map((candidate, index) => {
      const snippet =
        candidate.content.length > 300 ? `${candidate.content.slice(0, 300)}...` : candidate.content;
      return `[${index + 1}] (${candidate.source}) ${snippet}`;
    })
    .join("\n\n");

  const response = await llm
    .complete({
      system: "You rank retrieved code chunks by how well they answer a question.",
      user:
        `Question: ${question}\n\n` +
        `Below are ${candidates.length} retrieved text chunks, numbered. Identify the ` +
        `${keepTop} MOST relevant to actually answering the question, ordered from most to ` +
        `least relevant. Respond with ONLY a comma-separated list of chunk numbers ` +
        `(e.g. "3,1,7,2") — no other text.\n\n${numbered}`,
      temperature: 0,
    })
    .catch(() => null);

  const ranked = parseRanking(response, candidates.length, keepTop);
  if (ranked === null) return candidates;

  return ranked.map((index) => candidates[index]).filter((candidate) => candidate !== undefined);
}

/** Merges candidate sets from multiple queries, keeping the first occurrence (best-ranked) of each id. */
export function mergeCandidates(sets: RankableCandidate[][]): RankableCandidate[] {
  const merged: RankableCandidate[] = [];
  const seen = new Set<string>();

  for (const set of sets) {
    for (const candidate of set) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      merged.push(candidate);
    }
  }

  return merged;
}
