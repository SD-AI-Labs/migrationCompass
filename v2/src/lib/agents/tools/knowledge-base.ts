import { oneStringArgument, toolFailure } from "./types";
import type { AgentTool, ToolResult } from "./types";

/**
 * The knowledge-base tool: the RAG pipeline, exposed to agents.
 *
 * This is the same retrieval the ask bar uses — multi-query expansion, reranking,
 * grounded answer — not a second, cheaper implementation for agents. The plan's
 * point is that agents *compose* an existing capability; a parallel
 * "agent version" of retrieval would be a second thing to keep correct.
 *
 * The source is injected rather than imported, so the tool can be exercised with
 * a fake in tests and so the project scoping stays with the caller.
 */

export type KnowledgeAnswer = {
  answer: string;
  citations: { source: string; similarity: number }[];
  candidatesUsed: number;
  candidatesRetrieved: number;
};

export type KnowledgeSource = {
  /** Answers a question about one specific project's codebase. */
  answer(projectId: string, question: string): Promise<KnowledgeAnswer>;
};

export const KNOWLEDGE_BASE_TOOL_NAME = "queryKnowledgeBase";

export function createKnowledgeBaseTool(source: KnowledgeSource): AgentTool<{ question: string }> {
  return {
    name: KNOWLEDGE_BASE_TOOL_NAME,
    description:
      "Query the uploaded codebase's knowledge base — its actual source code, API specs, " +
      "database schema, and operational data if provided — to answer a specific question. " +
      "Use it repeatedly with focused questions: start broad (what services/components " +
      "exist?), then go deep on each thing found. Base every claim on what it returns.",
    parameters: oneStringArgument(
      "question",
      "A specific, focused question about the codebase, e.g. 'What services or components exist " +
        "in this codebase?' or 'What does the OrderReservation class do and what are its known issues?'",
    ),
    async run(input, context): Promise<ToolResult> {
      const question = input.question?.trim();
      if (!question) {
        return { ok: false, content: "ERROR: queryKnowledgeBase requires a non-empty question." };
      }

      try {
        const result = await source.answer(context.projectId, question);
        if (result.candidatesUsed === 0) {
          return {
            ok: true,
            content:
              "No relevant context was retrieved for that question in this codebase. " +
              "This is a real answer — the codebase may genuinely not contain it — not an error.",
          };
        }

        const sources = result.citations.map((citation) => citation.source);
        const uniqueSources = [...new Set(sources)];

        return {
          ok: true,
          content: [
            result.answer,
            "",
            `Sources: ${uniqueSources.join(", ") || "none"}`,
            `(grounded in ${result.candidatesUsed} of ${result.candidatesRetrieved} retrieved chunks)`,
          ].join("\n"),
        };
      } catch (error) {
        return toolFailure(
          KNOWLEDGE_BASE_TOOL_NAME,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
