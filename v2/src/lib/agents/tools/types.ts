/**
 * The tool boundary.
 *
 * Tools are plain objects with a `run` method, not framework-decorated classes,
 * for one reason: the plan makes "agents share tools" a first-class claim, and
 * sharing is only demonstrable if the same object can be handed to two agents and
 * observed doing so. A plain object makes identity checkable in a test.
 *
 * A tool returns `ToolResult` rather than throwing. That mirrors V1's behaviour
 * on purpose: a tool the model cannot reach has to come back as text the model
 * can read and reason about ("the knowledge base is unavailable"), not as an
 * exception that aborts the whole run. An agent that says "I could not check the
 * operational data" is useful; an agent that crashes is not.
 */

export type ToolContext = {
  /** Every tool is scoped to the run's project; no tool may read across projects. */
  projectId: string;
  runId: string;
};

export type ToolResult = {
  ok: boolean;
  content: string;
};

export type AgentTool<Input> = {
  name: string;
  /** Shown to the model, so it is written for the model, not for a log. */
  description: string;
  /**
   * JSON Schema for the tool's arguments. Required rather than inferred: the
   * model is told this shape, so a wrong or missing schema is a tool the model
   * cannot call correctly — it would guess argument names.
   */
  parameters: Record<string, unknown>;
  run(input: Input, context: ToolContext): Promise<ToolResult>;
};

/** The argument schema shared by every single-string-argument tool. */
export function oneStringArgument(name: string, description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { [name]: { type: "string", description } },
    required: [name],
    additionalProperties: false,
  };
}

/** Uniform error text so "unavailable" reads the same way across every tool. */
export function toolFailure(tool: string, detail: string): ToolResult {
  return { ok: false, content: `ERROR: ${tool} is unavailable right now. Details: ${detail}` };
}

/** Formats a tool payload as the indented text a model reads best. */
export function renderToolPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * A tool with its argument type erased.
 *
 * The tool-calling loop receives arguments as JSON from the model and cannot know
 * their static shape — it validates them at runtime instead. Rather than spread
 * `any` through the loop, the erasure is named once here and the single cast
 * happens where runtime JSON meets compile-time types.
 */
export type AnyAgentTool = AgentTool<never>;
