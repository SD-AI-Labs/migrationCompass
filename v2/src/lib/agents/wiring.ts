import { createDeepSeekLlm } from "@/lib/llm/client";
import { getProjectForOwner } from "@/lib/projects/repository";

import { createOperationalDataMonitoringSource, createRagKnowledgeSource } from "./sources";
import { createDrizzleAnalysisStore, createDrizzleRunStore } from "./stores";
import type { RunDeps } from "./run";
import { createSharedTools } from "./tools";

/**
 * Composes the real dependencies for an analysis run.
 *
 * The only place in the agent layer that knows about DeepSeek, Postgres, and
 * Ollama. Everything above it takes the ports it needs, which is what lets the
 * graph and the runner be exercised in tests with no infrastructure at all.
 *
 * Shared tools are created *once* here and handed to the whole run, so Architecture
 * and Risk are genuinely sharing instances — see the identity assertion in the
 * graph test.
 *
 * Comparison's ground truth is deliberately absent: M1 excludes `ground-truth/`
 * from ingestion (so the pipeline cannot retrieve the answer it is graded
 * against), and nothing has added a separate store for it yet. The Comparison
 * prompt therefore degrades to an internal-consistency evaluation and says so,
 * which is honest — better than a comparison against text it cannot read.
 */
export function createAnalysisDeps(): RunDeps {
  const tools = createSharedTools({
    knowledge: createRagKnowledgeSource(),
    monitoring: createOperationalDataMonitoringSource(),
  });

  return {
    llm: createDeepSeekLlm(),
    tools,
    runStore: createDrizzleRunStore(),
    analysisStore: createDrizzleAnalysisStore(),
    // Owner-scoped by construction: a project belonging to another session
    // resolves to null, and the runner refuses to start.
    resolveProject: async (ownerId, projectId) => {
      const project = await getProjectForOwner(ownerId, projectId);
      return project ? { id: project.id, name: project.name } : null;
    },
  };
}
