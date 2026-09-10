import type { ChatRequest, ChatResponse, LlmClient, LlmPrompt, ToolCall } from "@/lib/llm/client";

import type { SharedTools } from "../tools";
import type { ToolContext, ToolResult } from "../tools/types";

/**
 * Test support for the agent layer. Not part of the runtime surface.
 *
 * The model and the tools are faked here rather than mocked per-test because
 * every M3 assertion is about *orchestration* — what ran, in what order, how many
 * times, with what scope — and that requires recording calls, not stubbing
 * behaviour narrowly.
 *
 * The model is scripted by prompt tag. Tags are part of each call site's contract
 * (see `prompts.ts`), so these scripts keep working when prompt wording changes,
 * which substring-matched fakes do not.
 */

export type FakeReply =
  | string
  /** A chat reply: content plus any tool calls the model wants to make. */
  | { content: string; toolCalls?: { name: string; arguments?: string; id?: string }[] }
  | Error;

export type FakeScriptValue = FakeReply | FakeReply[] | ((call: ModelCall) => FakeReply | Promise<FakeReply>);
export type FakeScript = Record<string, FakeScriptValue>;

export type ModelCall = {
  tag: string;
  kind: "complete" | "chat" | "stream";
  prompt: string;
};

export type FakeModel = {
  llm: LlmClient;
  /** Every call in order, which is how ordering and call-count assertions work. */
  calls: ModelCall[];
  tags(): string[];
  countOf(tag: string): number;
};

function toChatReply(reply: Exclude<FakeReply, Error>): ChatResponse {
  if (typeof reply === "string") return { content: reply, toolCalls: [] };

  const toolCalls: ToolCall[] = (reply.toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.name,
    arguments: call.arguments ?? "{}",
  }));

  return { content: reply.content, toolCalls };
}

export function createFakeModel(script: FakeScript = {}): FakeModel {
  const calls: ModelCall[] = [];
  const queues = new Map<string, FakeReply[]>();

  const resolveReply = (entry: FakeScriptValue, tag: string): FakeReply => {
    if (Array.isArray(entry)) {
      const queue = queues.get(tag) ?? [...entry];
      const reply = queue.shift();
      queues.set(tag, queue);
      if (reply === undefined) {
        throw new Error(`Fake model ran out of scripted replies for tag "${tag}".`);
      }
      return reply;
    }

    return entry as FakeReply;
  };

  const nextReply = async (
    tag: string,
    kind: ModelCall["kind"],
    prompt: string,
  ): Promise<FakeReply> => {
    const call: ModelCall = { tag, kind, prompt };
    calls.push(call);

    const entry = script[tag];
    if (entry === undefined) {
      throw new Error(
        `Fake model has no script for tag "${tag}" (kind: ${kind}). Add it to the script — this ` +
          `also catches a pipeline that calls a step unexpectedly.`,
      );
    }

    // A function entry may await, which is how tests express "this branch cannot
    // proceed until the other branch has started" — the rendezvous that makes the
    // concurrency assertion real.
    const reply = typeof entry === "function" ? await entry(call) : resolveReply(entry, tag);
    return reply;
  };

  const llm: LlmClient = {
    name: "fake",
    async complete(prompt: LlmPrompt) {
      const reply = await nextReply(prompt.tag ?? "(untagged)", "complete", prompt.user);
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" ? reply : reply.content;
    },
    async chat(request: ChatRequest) {
      const tag = request.tag ?? "(untagged)";
      const prompt = request.messages.map((message) => message.content).join("\n");
      const reply = await nextReply(tag, "chat", prompt);
      if (reply instanceof Error) throw reply;
      return toChatReply(reply);
    },
    async *stream(prompt: LlmPrompt) {
      const reply = await nextReply(prompt.tag ?? "(untagged)", "stream", prompt.user);
      if (reply instanceof Error) throw reply;
      const text = typeof reply === "string" ? reply : reply.content;
      for (let offset = 0; offset < text.length; offset += 24) yield text.slice(offset, offset + 24);
    },
  };

  return {
    llm,
    calls,
    tags: () => calls.map((call) => call.tag),
    countOf: (tag: string) => calls.filter((call) => call.tag === tag).length,
  };
}

export type ToolInvocation = {
  tool: string;
  context: ToolContext;
  /** Identity of the tool object that ran, for the tool-sharing assertion. */
  instance: unknown;
};

export type FakeTools = {
  tools: SharedTools;
  invocations: ToolInvocation[];
  /** Called before a tool runs — the rendezvous hook for the concurrency test. */
  onInvoke?: (tool: string) => void;
  countOf(tool: string): number;
};

export function createFakeTools(
  options: {
    /** Values returned by checkApiHealth / getTrafficStats, keyed by service name. */
    health?: (serviceName: string) => string | null;
    traffic?: (serviceName: string) => string | null;
    knowledge?: (question: string) => string;
  } = {},
): FakeTools {
  const invocations: ToolInvocation[] = [];

  const record = (tool: string, context: ToolContext, instance: unknown): void => {
    invocations.push({ tool, context, instance });
    fake.onInvoke?.(tool);
  };

  const knowledgeBase: SharedTools["knowledgeBase"] = {
    name: "queryKnowledgeBase",
    description: "fake knowledge base",
    parameters: { type: "object", properties: {} },
    async run(input, context): Promise<ToolResult> {
      record("knowledgeBase", context, knowledgeBase);
      return { ok: true, content: options.knowledge?.(input.question) ?? `Answer about: ${input.question}` };
    },
  };

  const monitoringTool = (
    name: string,
    lookup: (serviceName: string) => string | null,
  ): SharedTools["checkApiHealth"] => {
    const instance: SharedTools["checkApiHealth"] = {
      name,
      description: `fake ${name}`,
      parameters: { type: "object", properties: {} },
      async run(input, context): Promise<ToolResult> {
        record(name, context, instance);
        const value = lookup(input.serviceName);
        return {
          ok: true,
          content: value ?? `No data found for service: ${input.serviceName}`,
        };
      },
    };
    return instance;
  };

  const checkApiHealth = monitoringTool("checkApiHealth", options.health ?? (() => null));
  const getTrafficStats = monitoringTool("getTrafficStats", options.traffic ?? (() => null));

  const fake: FakeTools = {
    tools: { knowledgeBase, checkApiHealth, getTrafficStats },
    invocations,
    countOf: (name: string) => invocations.filter((invocation) => invocation.tool === name).length,
  };

  return fake;
}

/** A valid Discovery structured output, for scripting extraction calls. */
export function discoveryJson(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    systemName: "OrderVault",
    summary: "Three SOAP services, a partner feed, and JMS messaging over one Oracle database.",
    services: [
      {
        name: "OrderLookupService",
        riskLevel: "low",
        riskFactors: ["read-only", "highest traffic volume"],
        recommendation: "Lift and shift first; simplest logic and highest stability.",
        hasTestCoverageGap: false,
        dataQualityIssueCount: 0,
        requiresMajorRestructuring: false,
      },
      {
        name: "CustomerAccountService",
        riskLevel: "high",
        riskFactors: ["handles PII", "no automated tests", "complex loyalty logic"],
        recommendation: "Add integration tests before touching it.",
        hasTestCoverageGap: true,
        dataQualityIssueCount: 2,
        requiresMajorRestructuring: true,
      },
    ],
    dependencies: [
      { from: "CustomerAccountService", to: "PostalVerificationApi", type: "synchronous call" },
      { from: "PartnerCatalogFeed", to: "InventoryCheckService", type: "shared database" },
      { from: "PartnerCatalogFeed", to: "InventoryCheckService", type: "shared database" },
    ],
    techStack: ["Java EE", "WebLogic", "Oracle", "JMS"],
    databaseOverview: "Single Oracle schema shared by three services.",
    messagingOverview: "JMS queues for order confirmation and warehouse picks.",
    externalIntegrations: "Postal verification API, payment gateway, carrier aggregator.",
    runtimeIssues: "NullPointerException in loyalty recalculation; 12 occurrences in the log sample.",
    ...overrides,
  });
}

export function architectureJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    migrationApproach: "Strangler fig, service by service, starting with the read path.",
    proposedServices: ["OrderLookupService", "CustomerAccountService"],
    keyTechnologyChoices: ["Spring Boot 3 on Java 21", "PostgreSQL replacing Oracle"],
    currentArchitectureLargelySound: false,
    phasedPlan: [
      {
        phaseNumber: 1,
        title: "Extract the read path",
        servicesInvolved: ["OrderLookupService"],
        rationale: "Lowest risk, highest traffic, no write path to migrate.",
      },
    ],
    ...overrides,
  });
}

export function riskJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ranked: [
      {
        serviceName: "CustomerAccountService",
        riskLevel: "critical",
        reasoning: "PII, no tests, and an unmitigated external dependency.",
        evidenceSource: "static_analysis",
      },
      {
        serviceName: "OrderLookupService",
        riskLevel: "low",
        reasoning: "Stable, read-only, simplest logic.",
        evidenceSource: "operational_data",
      },
      {
        serviceName: "PaymentGatewayClient",
        riskLevel: "high",
        reasoning: "Missing idempotency key risks double-charging.",
        evidenceSource: "static_analysis",
      },
    ],
    operationalDataAvailable: false,
    ...overrides,
  });
}

export function comparisonJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    matched: ["CustomerAccountService risk"],
    missed: ["no dead-letter queue on the warehouse consumer"],
    incorrect: [],
    accuracyAssessment: "Broadly accurate on the highest-risk service; missed messaging risk.",
    ...overrides,
  });
}
