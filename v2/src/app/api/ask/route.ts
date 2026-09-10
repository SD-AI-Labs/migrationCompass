import { z } from "zod";

import { hasDatabaseConfig } from "@/db/client";
import { embedInBatches, createOllamaEmbeddings } from "@/lib/embeddings/embeddings";
import { isConfigured, llmEnv } from "@/lib/env";
import { createDeepSeekLlm } from "@/lib/llm/client";
import { getLogger } from "@/lib/observability/logger";
import { withSpan } from "@/lib/observability/span";
import { getProjectForOwner } from "@/lib/projects/repository";
import { askStreaming } from "@/lib/rag/ask";
import { searchChunks } from "@/lib/rag/retrieve";
import { getOwnerId } from "@/lib/session";

/**
 * Streaming ask endpoint.
 *
 * Server-Sent Events rather than a JSON body, because the answer is watched
 * arriving: citations are emitted first so the UI can show what is being read
 * while the text streams, which is the difference between "the model is
 * thinking" and "here is the evidence I found".
 *
 * Runtime is Node, not edge: the pipeline needs postgres.js and a long-lived
 * outbound request to the model.
 */

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().min(3).max(2000),
  projectId: z.uuid(),
});

function sse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request): Promise<Response> {
  if (!hasDatabaseConfig()) {
    return Response.json({ error: "No database is configured." }, { status: 503 });
  }

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Expected { question: string, projectId: uuid }." },
      { status: 400 },
    );
  }

  const ownerId = await getOwnerId();
  if (!ownerId) {
    return Response.json({ error: "No session." }, { status: 403 });
  }

  // Ownership is checked before anything else, so a guessed project id cannot be
  // used to read another session's codebase through the ask path.
  const project = await getProjectForOwner(ownerId, parsed.data.projectId);
  if (!project) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  if (!isConfigured(llmEnv)) {
    return Response.json(
      { error: "DEEPSEEK_API_KEY is not set, so questions cannot be answered." },
      { status: 503 },
    );
  }

  const { question } = parsed.data;
  const llm = createDeepSeekLlm();
  const embeddings = createOllamaEmbeddings();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await withSpan("rag.ask", { "project.id": project.id }, async () => {
          for await (const event of askStreaming({
            question,
            deps: {
              llm,
              embed: (texts) => embedInBatches(embeddings, texts),
              retrieve: ({ queryEmbedding, limit }) =>
                searchChunks({ projectId: project.id, queryEmbedding, limit }),
            },
          })) {
            controller.enqueue(sse(event));
          }
        });
      } catch (error) {
        getLogger().error({ error, projectId: project.id }, "Ask pipeline failed");
        controller.enqueue(
          sse({
            type: "error",
            message: error instanceof Error ? error.message : "Answering failed.",
          }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
