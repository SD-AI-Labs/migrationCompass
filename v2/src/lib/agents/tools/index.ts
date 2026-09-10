import { createKnowledgeBaseTool, type KnowledgeSource } from "./knowledge-base";
import { createMonitoringTools, type MonitoringSource } from "./monitoring";
import type { AgentTool, AnyAgentTool } from "./types";

/**
 * The shared tool set.
 *
 * Created once per run and handed to more than one agent — that is the plan's
 * "agents sharing tools with each other" claim, and it is a claim about object
 * identity, not about both agents happening to call similar functions. The graph
 * builds this once and passes the same instance to Architecture and Risk, which
 * is asserted by test.
 *
 * The alternative — each agent constructing its own tools — is what this is
 * designed to avoid: two implementations of "query the knowledge base" would
 * drift, and the second one would be the one nobody reviews.
 */

export type SharedTools = {
  knowledgeBase: AgentTool<{ question: string }>;
  checkApiHealth: AgentTool<{ serviceName: string }>;
  getTrafficStats: AgentTool<{ serviceName: string }>;
};

export type SharedToolSources = {
  knowledge: KnowledgeSource;
  monitoring: MonitoringSource;
};

export function createSharedTools(sources: SharedToolSources): SharedTools {
  return {
    knowledgeBase: createKnowledgeBaseTool(sources.knowledge),
    ...createMonitoringTools(sources.monitoring),
  };
}

/**
 * The tools each agent may use.
 *
 * Discovery gets the knowledge base only: it is building the inventory, and
 * inventing a risk judgment from traffic numbers at that stage would be
 * premature. Risk gets the operational signal tools *and* the knowledge base, to
 * follow up on a specific code detail the Discovery summary did not fully cover.
 * Architecture gets the knowledge base for the same reason — verifying a
 * boundary claim before proposing to redraw it.
 */
export const TOOLS_BY_AGENT = {
  discovery: ["knowledgeBase"],
  architecture: ["knowledgeBase"],
  risk: ["knowledgeBase", "checkApiHealth", "getTrafficStats"],
  /**
   * Comparison gets nothing, deliberately. Its job is to evaluate reports against
   * a reference, not to investigate the codebase — giving it retrieval would let
   * it rewrite the analysis it is supposed to be grading, and would make it a
   * participant in the thing it evaluates.
   */
  comparison: [],
} as const satisfies Record<string, readonly (keyof SharedTools)[]>;

export function toolsFor(tools: SharedTools, agent: keyof typeof TOOLS_BY_AGENT): AnyAgentTool[] {
  return TOOLS_BY_AGENT[agent].map((name) => tools[name] as AnyAgentTool);
}

export type { AgentTool, AnyAgentTool, ToolContext, ToolResult } from "./types";
export { renderToolPayload, toolFailure } from "./types";
