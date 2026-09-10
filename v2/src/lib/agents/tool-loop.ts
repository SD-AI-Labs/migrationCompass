import type { ChatMessage, LlmClient, ToolDefinition } from "@/lib/llm/client";

import type { AnyAgentTool, ToolContext } from "./tools/types";

/**
 * The bounded tool-calling loop.
 *
 * This is the ReAct-shaped cycle V1's agents ran via Spring AI's tool calling,
 * written out explicitly so the iteration bound is a property of the code rather
 * than of a framework's defaults. Every agent that uses tools runs through here,
 * and nothing else in the pipeline loops on model output.
 *
 * Three decisions worth stating:
 *
 * 1. **The bound is enforced, not requested.** A model that keeps asking for
 *    tools is cut off at `MAX_TOOL_ITERATIONS`. The loop reports `stoppedEarly`
 *    so the caller can tell "the model finished" from "the model was stopped",
 *    which are different enough that conflating them would hide a misbehaving
 *    prompt.
 * 2. **Tool failures are text, not exceptions.** A tool that throws, a tool name
 *    the model invented, and arguments that are not valid JSON all become an
 *    `ERROR:` message the model reads on the next turn. The model can correct
 *    itself; an exception cannot be corrected and would abort the whole run over
 *    one bad call.
 * 3. **Messages accumulate in the wire shape**, including the assistant's own
 *    `tool_calls` echoed back. Omitting that echo is a common bug: the model sees
 *    tool results with no record of having asked for them, and answers as if the
 *    data arrived unbidden.
 */

/** Six is generous for an investigation agent; a model exceeding it is looping, not investigating. */
export const MAX_TOOL_ITERATIONS = 6;

export type ToolInvocation = {
  name: string;
  /** Raw arguments as emitted, kept for diagnosis even when they do not parse. */
  arguments: string;
  ok: boolean;
  content: string;
};

export type ToolLoopResult = {
  /** The model's final free-text answer. Empty when the loop was cut off before one. */
  content: string;
  iterations: number;
  invocations: ToolInvocation[];
  /** True when the iteration ceiling was hit before the model produced an answer. */
  stoppedEarly: boolean;
};

export type ToolLoopInput = {
  llm: LlmClient;
  messages: ChatMessage[];
  tools: AnyAgentTool[];
  context: ToolContext;
  maxIterations?: number;
  temperature?: number;
  tag?: string;
};

export function toolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

async function executeTool(
  name: string,
  rawArguments: string,
  tools: AnyAgentTool[],
  context: ToolContext,
): Promise<{ ok: boolean; content: string }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    const available = tools.map((candidate) => candidate.name).join(", ");
    return { ok: false, content: `ERROR: no tool named "${name}" exists. Available tools: ${available}.` };
  }

  let parsed: unknown;
  try {
    parsed = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
  } catch (error) {
    return {
      ok: false,
      content:
        `ERROR: arguments for "${name}" were not valid JSON ` +
        `(${error instanceof Error ? error.message : "unknown"}). Received: ${rawArguments.slice(0, 200)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, content: `ERROR: arguments for "${name}" must be a JSON object.` };
  }

  try {
    // The single erasure point: arguments arrive as runtime JSON, and the tool's
    // static input type is a promise the caller cannot verify here.
    return await tool.run(parsed as never, context);
  } catch (error) {
    return {
      ok: false,
      content: `ERROR: "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxIterations = input.maxIterations ?? MAX_TOOL_ITERATIONS;
  const definitions = toolDefinitions(input.tools);
  const messages: ChatMessage[] = [...input.messages];
  const invocations: ToolInvocation[] = [];

  let lastContent = "";

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const response = await input.llm.chat({
      messages,
      tools: definitions,
      temperature: input.temperature,
      tag: input.tag,
    });

    if (response.toolCalls.length === 0) {
      return { content: response.content, iterations: iteration, invocations, stoppedEarly: false };
    }

    lastContent = response.content;
    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      const result = await executeTool(call.name, call.arguments, input.tools, input.context);
      invocations.push({
        name: call.name,
        arguments: call.arguments,
        ok: result.ok,
        content: result.content,
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
      });
    }
  }

  return {
    content: lastContent,
    iterations: maxIterations,
    invocations,
    stoppedEarly: true,
  };
}
