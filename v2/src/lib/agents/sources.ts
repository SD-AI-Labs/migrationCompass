import { and, eq, inArray } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { operationalData } from "@/db/schema";
import { embedInBatches, createOllamaEmbeddings } from "@/lib/embeddings/embeddings";
import { createDeepSeekLlm, type LlmClient } from "@/lib/llm/client";
import { getLogger } from "@/lib/observability/logger";
import { askQuestion } from "@/lib/rag/ask";
import { searchChunks } from "@/lib/rag/retrieve";

import type { KnowledgeAnswer, KnowledgeSource } from "./tools/knowledge-base";
import { selectServiceEntry, type MonitoringEntry, type MonitoringSource } from "./tools/monitoring";

/**
 * Real implementations of the ports the shared tools depend on.
 *
 * Kept out of the tool modules on purpose: the tools are pure logic over a port
 * and stay testable without a database; everything that touches the outside world
 * lives here, where it is one file to audit.
 */

/**
 * The knowledge base, backed by the *existing* RAG pipeline.
 *
 * Same expansion, retrieval, reranking, and grounding as the ask bar — the agents
 * compose the capability the product already has rather than getting a cheaper
 * internal one. The plan's whole point is that this is one retrieval path, not two.
 */
export function createRagKnowledgeSource(llm: LlmClient = createDeepSeekLlm()): KnowledgeSource {
  const embeddings = createOllamaEmbeddings();

  return {
    async answer(projectId: string, question: string): Promise<KnowledgeAnswer> {
      const logger = getLogger();
      const startedAt = Date.now();

      // Evidence retrieval, logged here rather than in the tool because this is the
      // implementation that touches the database and the model. The question is
      // reported as a length, never as text: it is model-written prose about the
      // user's source, and the logger's contract is counts and references, not
      // content. `projectId` scopes the pair; the run's trace id (injected into
      // every line by the logger) ties them to one analysis.
      logger.info({ stage: "retrieval", projectId, questionChars: question.length }, "Evidence retrieval started");

      try {
        const result = await askQuestion({
          question,
          deps: {
            llm,
            embed: (texts) => embedInBatches(embeddings, texts),
            // Scoped to the run's project at the point of the query, so an agent
            // cannot retrieve another project's source through the tool.
            retrieve: ({ queryEmbedding, limit }) =>
              searchChunks({ projectId, queryEmbedding, limit }),
          },
        });

        logger.info(
          {
            stage: "retrieval",
            projectId,
            durationMs: Date.now() - startedAt,
            candidatesRetrieved: result.candidatesRetrieved,
            candidatesUsed: result.candidatesUsed,
            citations: result.citations.length,
          },
          "Evidence retrieval completed",
        );

        return {
          answer: result.answer,
          citations: result.citations.map((citation) => ({
            source: citation.source,
            similarity: citation.similarity,
          })),
          candidatesUsed: result.candidatesUsed,
          candidatesRetrieved: result.candidatesRetrieved,
        };
      } catch (error) {
        logger.error(
          {
            stage: "retrieval",
            projectId,
            durationMs: Date.now() - startedAt,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          "Evidence retrieval failed",
        );
        throw error;
      }
    },
  };
}

/**
 * Operational signals, read from the project's stored operational data.
 *
 * M5 adds the ingestion that fills this table. M3 defines the boundary and the
 * honest empty case: with no rows, both tools answer "no data", which is the
 * truth and which the Risk Agent is instructed to treat as a normal code-only
 * assessment rather than a failure.
 */
export function createOperationalDataMonitoringSource(db: Database = getDb()): MonitoringSource {
  const loadEntries = async (
    projectId: string,
    kinds: readonly ("health" | "traffic" | "incident" | "log" | "db_stats")[],
  ): Promise<MonitoringEntry[]> => {
    const rows = await db
      .select()
      .from(operationalData)
      .where(and(eq(operationalData.projectId, projectId), inArray(operationalData.kind, kinds)));

    return rows.map((row) => {
      if (row.payload && typeof row.payload === "object") return row.payload;
      // Text-shaped rows (a log excerpt, an incident write-up) are keyed by their
      // source so a service-name lookup can still match them.
      return { service: row.source, content: row.content ?? "" };
    });
  };

  return {
    async health(projectId, serviceName) {
      const entries = await loadEntries(projectId, ["health", "incident"]);
      return selectServiceEntry(entries, serviceName);
    },
    async traffic(projectId, serviceName) {
      const entries = await loadEntries(projectId, ["traffic", "db_stats"]);
      return selectServiceEntry(entries, serviceName);
    },
  };
}
