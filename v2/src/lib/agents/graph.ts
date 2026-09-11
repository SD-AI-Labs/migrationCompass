import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { z } from "zod";

import type { LlmClient } from "@/lib/llm/client";

import {
  critiquePrompt,
  draftPrompt,
  extractionPrompt,
  extractionRetryPrompt,
  refinePrompt,
} from "./prompts";
import type { AgentStage, CritiquedStage, StageContext } from "./prompts";
import { runBoundedRefinement } from "./refinement";
import {
  AgentOutputError,
  architectureOutputSchema,
  comparisonOutputSchema,
  discoveryOutputSchema,
  normalizeDependencies,
  parseAgentOutput,
  riskAssessmentSchema,
} from "./schemas";
import type {
  ArchitectureOutput,
  ComparisonOutput,
  DiscoveryOutput,
  RiskOutput,
} from "./schemas";
import { toolsFor, type SharedTools } from "./tools";
import type { ToolContext } from "./tools/types";
import { runToolLoop } from "./tool-loop";

/**
 * The analysis graph.
 *
 * ```
 *                 ┌── architecture ──┐
 * START → discovery┤                  ├→ comparison → END
 *                 └── risk ──────────┘
 * ```
 *
 * Discovery runs first; Architecture and Risk both consume its result and run
 * *concurrently*; Comparison waits for both. The fan-out is the real thing, not a
 * sequential sequence with parallel-looking comments — the structural test
 * asserts concurrency with a rendezvous that would deadlock if the branches were
 * serialized.
 *
 * Why the shape matters rather than being decoration: Architecture and Risk are
 * independent evaluations of the same Discovery output, so making one wait on the
 * other would add latency for nothing and would imply a dependency that does not
 * exist. Comparison is the only stage that needs both, and the only one that waits.
 *
 * Everything the graph needs is injected: the model, the shared tools, and a
 * stage-transition callback. There are no module-level model clients, so the graph
 * runs in a test with no API key, no Ollama, and no database.
 */

export type StageTiming = { durationMs: number; toolCalls: number };

export type AgentDeps = {
  llm: LlmClient;
  /** One instance, shared by more than one agent — the plan's tool-sharing claim. */
  tools: SharedTools;
  /**
   * Called as each stage begins. This is where the runner persists the step
   * transition, which is why it is a callback rather than something the graph
   * knows about: the graph must not depend on a database.
   */
  onStageStart?: (stage: AgentStage) => Promise<void>;
  /**
   * Called when a stage finishes, with how long it took and how many tool calls it
   * made. Timed by the node itself because Architecture and Risk run concurrently —
   * a caller measuring between stage transitions would attribute their overlap to
   * whichever reported last.
   */
  onStageEnd?: (stage: AgentStage, timing: StageTiming) => Promise<void> | void;
  maxToolIterations?: number;
};

export type DiscoveryResult = {
  narrative: string;
  structured: DiscoveryOutput;
  wasRefined: boolean;
  toolCalls: number;
};

export type ArchitectureResult = {
  narrative: string;
  structured: ArchitectureOutput;
  wasRefined: boolean;
  toolCalls: number;
};

export type RiskResult = {
  narrative: string;
  structured: RiskOutput;
  wasRefined: boolean;
  toolCalls: number;
};

export type ComparisonResult = {
  narrative: string;
  structured: ComparisonOutput;
  toolCalls: number;
};

export type AnalysisOutcome = {
  discovery: DiscoveryResult;
  architecture: ArchitectureResult;
  risk: RiskResult;
  comparison: ComparisonResult;
  /**
   * The stages the graph recorded completing, in completion order. Surfaced
   * because it is the graph's own account of what happened — useful for run
   * diagnostics, and what the structural test reads instead of trusting the edge
   * declarations to describe the execution.
   */
  completedStages: AgentStage[];
};

const AnalysisState = Annotation.Root({
  projectId: Annotation<string>,
  runId: Annotation<string>,
  discovery: Annotation<DiscoveryResult | undefined>,
  architecture: Annotation<ArchitectureResult | undefined>,
  risk: Annotation<RiskResult | undefined>,
  comparison: Annotation<ComparisonResult | undefined>,
  /**
   * Appended in completion order by the reducer. This is the graph's own record of
   * what actually ran and in what order — what the structural test reads, rather
   * than trusting the edge declarations to describe what happened.
   */
  completedStages: Annotation<AgentStage[]>({
    reducer: (left, right) => [...(left ?? []), ...(right ?? [])],
    default: () => [],
  }),
});

type GraphState = typeof AnalysisState.State;

/** Node-level guard: a missing prerequisite is a wiring bug, not a runtime condition. */
function requireStage<T>(value: T | undefined, stage: AgentStage, prerequisite: string): T {
  if (value === undefined) {
    throw new Error(
      `The ${stage} stage ran without a ${prerequisite} result. The graph's edges should make ` +
        `this impossible, so this indicates the graph was wired incorrectly.`,
    );
  }
  return value;
}

/** Invoke-level guard: the graph completed, so every stage must be present. */
function requireOutcome<T>(value: T | undefined, stage: AgentStage): T {
  if (value === undefined) {
    throw new Error(`The graph completed without producing a ${stage} result.`);
  }
  return value;
}

function toolContextOf(state: GraphState): ToolContext {
  return { projectId: state.projectId, runId: state.runId };
}

/**
 * A stage that drafts with tools, is critiqued, optionally refined once, and is
 * then extracted into a validated structured output.
 *
 * Extraction is a separate model call rather than asking the drafting model to
 * emit JSON directly. That is the same split V1 used, and the reason still holds:
 * a model writing an analytical report and a model producing strict JSON are
 * doing different jobs, and asking one pass to do both degrades both.
 */
async function runAgentStage<S>(input: {
  stage: AgentStage;
  deps: AgentDeps;
  context: StageContext;
  toolContext: ToolContext;
  schema: z.ZodType<S>;
  isCritiqued: boolean;
}): Promise<{ narrative: string; structured: S; wasRefined: boolean; toolCalls: number }> {
  const { stage, deps, context, toolContext, schema } = input;
  const tools = toolsFor(deps.tools, stage);

  let toolCalls = 0;

  const draft = async (): Promise<string> => {
    const prompt = draftPrompt(stage, context);
    const result = await runToolLoop({
      llm: deps.llm,
      messages: [
        ...(prompt.system ? [{ role: "system" as const, content: prompt.system }] : []),
        { role: "user" as const, content: prompt.user },
      ],
      tools,
      context: toolContext,
      maxIterations: deps.maxToolIterations,
      tag: prompt.tag,
    });
    toolCalls += result.invocations.length;

    if (result.content.trim().length === 0) {
      throw new AgentOutputError(
        `${stage} draft`,
        result.stoppedEarly
          ? `the agent hit its tool-call limit (${result.iterations} iterations) without producing a report.`
          : "the agent produced an empty report.",
        "",
      );
    }
    return result.content;
  };

  const critique = async (current: string): Promise<string> =>
    deps.llm.complete(critiquePrompt(stage as CritiquedStage, current, context));

  /**
   * Refinement gets tools (it is investigating the gaps the critique named) while
   * the critique call does not (its job is to judge a write-up, and handing it
   * tools invites it to rewrite the report instead of reviewing it).
   */
  const refine = async (current: string, gaps: string): Promise<string> => {
    const prompt = refinePrompt(stage as CritiquedStage, current, gaps, context);
    const result = await runToolLoop({
      llm: deps.llm,
      messages: [
        ...(prompt.system ? [{ role: "system" as const, content: prompt.system }] : []),
        { role: "user" as const, content: prompt.user },
      ],
      tools,
      context: toolContext,
      maxIterations: deps.maxToolIterations,
      tag: prompt.tag,
    });
    toolCalls += result.invocations.length;

    // An empty refinement would otherwise overwrite a usable draft with nothing,
    // turning a partial improvement into a total loss.
    return result.content.trim().length > 0 ? result.content : current;
  };

  const outcome = input.isCritiqued
    ? await runBoundedRefinement({ draft, critique, refine })
    : { finalText: await draft(), wasRefined: false };

  const structured = await extractStructured(stage, outcome.finalText, schema, deps);

  return { narrative: outcome.finalText, structured, wasRefined: outcome.wasRefined, toolCalls };
}

/**
 * Converts a narrative into a validated structured output, retrying once.
 *
 * The retry is bounded at one, and the validator's own message is sent back
 * verbatim — it names the failing field, which is exactly what the model needs to
 * correct itself. A second failure is a hard failure: re-prompting indefinitely
 * against a schema the model cannot satisfy burns tokens and delays a run that is
 * going to fail anyway.
 */
export async function extractStructured<S>(
  stage: AgentStage,
  narrative: string,
  schema: z.ZodType<S>,
  deps: Pick<AgentDeps, "llm">,
): Promise<S> {
  const label = `${stage} structured output`;

  try {
    const raw = await deps.llm.complete(extractionPrompt(stage, narrative));
    return parseAgentOutput(raw, schema, label);
  } catch (error) {
    if (!(error instanceof AgentOutputError)) throw error;

    const retry = await deps.llm.complete(extractionRetryPrompt(stage, narrative, error.message));
    return parseAgentOutput(retry, schema, `${label} (retry)`);
  }
}

/**
 * Runs one stage, announcing it before it begins and reporting its timing when it
 * finishes.
 *
 * The announcement stays ahead of the work — a `step` written after the fact would
 * tell a poller where a run *was*, not where it is — and the duration is measured
 * around the stage's own work so concurrent branches are timed independently.
 */
async function runTimedStage<T extends { toolCalls: number }>(
  deps: AgentDeps,
  stage: AgentStage,
  run: () => Promise<T>,
): Promise<T> {
  await deps.onStageStart?.(stage);
  const startedAt = Date.now();
  const result = await run();
  await deps.onStageEnd?.(stage, {
    durationMs: Date.now() - startedAt,
    toolCalls: result.toolCalls,
  });
  return result;
}

async function discoveryNode(state: GraphState, deps: AgentDeps): Promise<Partial<GraphState>> {
  const result = await runTimedStage(deps, "discovery", () =>
    runAgentStage({
      stage: "discovery",
      deps,
      context: {},
      toolContext: toolContextOf(state),
      schema: discoveryOutputSchema,
      isCritiqued: true,
    }),
  );

  return {
    discovery: {
      ...result,
      // Normalized where edges enter the pipeline, so every later consumer sees
      // the same cleaned edge list — no self-edges, no duplicates.
      structured: {
        ...result.structured,
        dependencies: normalizeDependencies(result.structured.dependencies),
      },
    },
    completedStages: ["discovery"],
  };
}

async function architectureNode(state: GraphState, deps: AgentDeps): Promise<Partial<GraphState>> {
  const discovery = requireStage(state.discovery, "architecture", "Discovery");

  const result = await runTimedStage(deps, "architecture", () =>
    runAgentStage({
      stage: "architecture",
      deps,
      context: { discoveryReport: discovery.narrative },
      toolContext: toolContextOf(state),
      schema: architectureOutputSchema,
      isCritiqued: true,
    }),
  );

  return { architecture: result, completedStages: ["architecture"] };
}

async function riskNode(state: GraphState, deps: AgentDeps): Promise<Partial<GraphState>> {
  const discovery = requireStage(state.discovery, "risk", "Discovery");

  const result = await runTimedStage(deps, "risk", () =>
    runAgentStage({
      stage: "risk",
      deps,
      context: { discoveryReport: discovery.narrative },
      toolContext: toolContextOf(state),
      schema: riskAssessmentSchema,
      isCritiqued: true,
    }),
  );

  return { risk: result, completedStages: ["risk"] };
}

async function comparisonNode(state: GraphState, deps: AgentDeps): Promise<Partial<GraphState>> {
  const discovery = requireStage(state.discovery, "comparison", "Discovery");
  const architecture = requireStage(state.architecture, "comparison", "Architecture");
  const risk = requireStage(state.risk, "comparison", "Risk");

  const result = await runTimedStage(deps, "comparison", () =>
    runAgentStage({
      stage: "comparison",
      deps,
      context: {
        discoveryReport: discovery.narrative,
        architectureProposal: architecture.narrative,
        riskAssessment: risk.narrative,
      },
      toolContext: toolContextOf(state),
      schema: comparisonOutputSchema,
      // Comparison's whole job is to critique honestly; layering a
      // critique-of-the-critique on top adds cost and risks softening the
      // assessment into something more agreeable. Deliberately not critiqued.
      isCritiqued: false,
    }),
  );

  return { comparison: result, completedStages: ["comparison"] };
}

export function createAnalysisGraph(deps: AgentDeps) {
  // Node names are prefixed because LangGraph forbids a node sharing a name with a
  // state channel, and the channels are deliberately the domain words
  // (`discovery`, `architecture`, …) that the rest of the pipeline reads.
  return new StateGraph(AnalysisState)
    .addNode("runDiscovery", (state) => discoveryNode(state, deps))
    .addNode("runArchitecture", (state) => architectureNode(state, deps))
    .addNode("runRisk", (state) => riskNode(state, deps))
    .addNode("runComparison", (state) => comparisonNode(state, deps))
    .addEdge(START, "runDiscovery")
    // Fan-out: both branches consume Discovery and neither waits on the other.
    .addEdge("runDiscovery", "runArchitecture")
    .addEdge("runDiscovery", "runRisk")
    // Fan-in: Comparison is the only node with two predecessors, so it is the
    // only one that waits — and it runs exactly once, not once per incoming edge.
    .addEdge("runArchitecture", "runComparison")
    .addEdge("runRisk", "runComparison")
    .addEdge("runComparison", END)
    .compile();
}

export async function runAnalysisGraph(input: {
  projectId: string;
  runId: string;
  deps: AgentDeps;
}): Promise<AnalysisOutcome> {
  const graph = createAnalysisGraph(input.deps);
  const final = await graph.invoke({ projectId: input.projectId, runId: input.runId });

  return {
    discovery: requireOutcome(final.discovery, "discovery"),
    architecture: requireOutcome(final.architecture, "architecture"),
    risk: requireOutcome(final.risk, "risk"),
    comparison: requireOutcome(final.comparison, "comparison"),
    completedStages: final.completedStages ?? [],
  };
}
