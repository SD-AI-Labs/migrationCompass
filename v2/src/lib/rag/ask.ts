import type { LlmClient } from "@/lib/llm/client";

import { expandQuery } from "./multiQuery";
import { mergeCandidates, rerankCandidates } from "./rerank";
import type { RankableCandidate } from "./rerank";
import type { RetrievedChunk } from "./retrieve";

/**
 * The ask pipeline, as one function with injected dependencies.
 *
 * Per question: expand → embed the expanded set → retrieve per query → merge →
 * rerank → answer. That is two extra model calls and 3× the vector searches
 * beyond the answer itself, which is a deliberate cost stated in the plan rather
 * than an accident of composition.
 *
 * The returned object always reports how many candidates were retrieved versus
 * used. Progressive disclosure needs that number: "8 of 41 chunks" is the honest
 * framing of what the answer is grounded in, and a UI that cannot say it invites
 * the reader to assume the answer considered everything.
 */

export const DEFAULT_QUERY_COUNT = 3;
export const DEFAULT_RETRIEVE_LIMIT = 6;
export const DEFAULT_KEEP_TOP = 8;

export type AskDeps = {
  llm: LlmClient;
  /** Batch embedder — one call per query set, not one per query. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Retrieval port, pre-scoped to the project being asked about. */
  retrieve: (input: { queryEmbedding: number[]; limit: number }) => Promise<RetrievedChunk[]>;
};

export type Citation = {
  source: string;
  documentType: string;
  similarity: number;
};

export type AskOptions = {
  question: string;
  deps: AskDeps;
  queryCount?: number;
  retrieveLimit?: number;
  keepTop?: number;
};

export type AskResult = {
  answer: string;
  /** The queries actually searched, original first. */
  queries: string[];
  citations: Citation[];
  candidatesRetrieved: number;
  candidatesUsed: number;
};

const SYSTEM_PROMPT = [
  "You are a technical assistant analysing a codebase that has been uploaded for a",
  "modernization/migration assessment.",
  "",
  "Ground every answer in the retrieved context below. Cite specific file names or class",
  "names where relevant, rather than speaking generally. If the retrieved context does not",
  "contain enough information to answer confidently, say so explicitly rather than guessing",
  "or inventing details.",
].join("\n");

/** Renders the numbered context block the answer is grounded in. */
export function buildContext(candidates: RankableCandidate[]): string {
  if (candidates.length === 0) {
    return "(no relevant context was retrieved for this question)";
  }
  return candidates
    .map((candidate, index) => `[${index + 1}] ${candidate.source}\n${candidate.content}`)
    .join("\n\n---\n\n");
}

export function buildAnswerPrompt(question: string, candidates: RankableCandidate[]): string {
  return `Retrieved context:\n\n${buildContext(candidates)}\n\nQuestion: ${question}`;
}

export type AskStreamEvent =
  | { type: "citations"; citations: Citation[]; queries: string[]; candidatesRetrieved: number; candidatesUsed: number }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string };

async function gatherCandidates(options: AskOptions): Promise<{
  queries: string[];
  candidates: RankableCandidate[];
  retrieved: RetrievedChunk[];
}> {
  const { question, deps } = options;
  const retrieveLimit = options.retrieveLimit ?? DEFAULT_RETRIEVE_LIMIT;
  const keepTop = options.keepTop ?? DEFAULT_KEEP_TOP;

  const queries = await expandQuery(question, deps.llm, { count: options.queryCount ?? DEFAULT_QUERY_COUNT });

  // One embedding call for the whole query set: the vector is the input to a
  // search, so batching here is free latency.
  const vectors = await deps.embed(queries);

  const perQuery = await Promise.all(
    queries.map((_, index) =>
      deps.retrieve({ queryEmbedding: vectors[index] ?? [], limit: retrieveLimit }),
    ),
  );

  const retrieved = perQuery.flat();
  const merged = mergeCandidates(perQuery);
  const ranked = await rerankCandidates({ question, candidates: merged, keepTop, llm: deps.llm });

  return { queries, candidates: ranked, retrieved };
}

function toCitations(candidates: RankableCandidate[], retrieved: RetrievedChunk[]): Citation[] {
  const similarityById = new Map(retrieved.map((chunk) => [chunk.id, chunk]));
  return candidates.map((candidate) => {
    const match = similarityById.get(candidate.id);
    return {
      source: candidate.source,
      documentType: match?.documentType ?? "unknown",
      similarity: match?.similarity ?? 0,
    };
  });
}

/**
 * Streams the answer: citations first (so the UI can show what is being read
 * before the first token arrives), then deltas, then the assembled answer.
 */
export async function* askStreaming(options: AskOptions): AsyncIterable<AskStreamEvent> {
  const { question, deps } = options;
  const { queries, candidates, retrieved } = await gatherCandidates(options);
  const citations = toCitations(candidates, retrieved);

  yield {
    type: "citations",
    citations,
    queries,
    candidatesRetrieved: retrieved.length,
    candidatesUsed: candidates.length,
  };

  let answer = "";
  for await (const delta of deps.llm.stream({
    system: SYSTEM_PROMPT,
    user: buildAnswerPrompt(question, candidates),
    temperature: 0.2,
  })) {
    answer += delta;
    yield { type: "delta", text: delta };
  }

  yield { type: "done", answer };
}

/** Non-streaming convenience wrapper over the same pipeline. */
export async function askQuestion(options: AskOptions): Promise<AskResult> {
  let result: AskResult | undefined;

  for await (const event of askStreaming(options)) {
    if (event.type === "citations") {
      result = {
        answer: "",
        queries: event.queries,
        citations: event.citations,
        candidatesRetrieved: event.candidatesRetrieved,
        candidatesUsed: event.candidatesUsed,
      };
    } else if (event.type === "done" && result) {
      result.answer = event.answer;
    }
  }

  if (!result) throw new Error("Ask pipeline produced no result.");
  return result;
}
