import { describe, expect, it } from "vitest";

import { createKnowledgeBaseTool } from "./knowledge-base";
import type { KnowledgeSource } from "./knowledge-base";
import {
  createMonitoringTools,
  entryMatchesService,
  normalizeServiceName,
  selectServiceEntry,
  type MonitoringSource,
} from "./monitoring";
import { createSharedTools, TOOLS_BY_AGENT, toolsFor } from "./index";
import { oneStringArgument } from "./types";

const context = { projectId: "p1", runId: "r1" };

describe("knowledgeBase tool", () => {
  const source = (overrides: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
    answer: async () => ({
      answer: "Order status is resolved by OrderLookupService.",
      citations: [
        { source: "src/OrderLookupService.java", similarity: 0.91 },
        { source: "src/OrderDAO.java", similarity: 0.62 },
        { source: "src/OrderLookupService.java", similarity: 0.55 },
      ],
      candidatesUsed: 3,
      candidatesRetrieved: 18,
    }),
    ...overrides,
  });

  it("returns the answer with its sources", async () => {
    const tool = createKnowledgeBaseTool(source());
    const result = await tool.run({ question: "how is order status resolved?" }, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Order status is resolved by OrderLookupService.");
    expect(result.content).toContain("src/OrderLookupService.java");
    expect(result.content).toContain("src/OrderDAO.java");
  });

  it("de-duplicates sources that appear more than once", async () => {
    // Three retrievals over one codebase routinely surface the same file; three
    // identical citations would read as three independent confirmations.
    const tool = createKnowledgeBaseTool(source());
    const result = await tool.run({ question: "q" }, context);
    const occurrences = result.content.split("src/OrderLookupService.java").length - 1;
    expect(occurrences).toBe(1);
  });

  it("reports how much of the retrieved set the answer is grounded in", async () => {
    const tool = createKnowledgeBaseTool(source());
    const result = await tool.run({ question: "q" }, context);
    expect(result.content).toContain("3 of 18 retrieved chunks");
  });

  it("says plainly when nothing relevant was retrieved", async () => {
    // An empty retrieval is an answer about the codebase, not a tool error — and
    // saying so is what stops the agent filling the gap with invention.
    const tool = createKnowledgeBaseTool(
      source({
        answer: async () => ({ answer: "", citations: [], candidatesUsed: 0, candidatesRetrieved: 41 }),
      }),
    );
    const result = await tool.run({ question: "unrelated" }, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No relevant context");
  });

  it("reports an unreachable knowledge base as tool text, not an exception", async () => {
    const tool = createKnowledgeBaseTool(
      source({
        answer: async () => {
          throw new Error("Ollama embeddings request failed (503)");
        },
      }),
    );
    const result = await tool.run({ question: "q" }, context);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("ERROR");
    expect(result.content).toContain("503");
  });

  it("rejects an empty question", async () => {
    const tool = createKnowledgeBaseTool(source());
    expect((await tool.run({ question: "   " }, context)).ok).toBe(false);
  });

  it("scopes the query to the run's project", async () => {
    const seen: string[] = [];
    const tool = createKnowledgeBaseTool({
      answer: async (projectId) => {
        seen.push(projectId);
        return { answer: "a", citations: [], candidatesUsed: 1, candidatesRetrieved: 1 };
      },
    });

    await tool.run({ question: "q" }, { projectId: "project-42", runId: "r" });
    expect(seen).toEqual(["project-42"]);
  });
});

describe("service-name matching", () => {
  it("normalizes separators and case", () => {
    expect(normalizeServiceName("Order-LookupService")).toBe("orderlookupservice");
    expect(normalizeServiceName("order_lookup_service")).toBe("orderlookupservice");
    expect(normalizeServiceName("OrderLookupService")).toBe("orderlookupservice");
  });

  it("matches across naming conventions, which is the whole point", () => {
    // A model asks about "OrderLookupService"; the stored key is
    // "order-lookup-service". Exact matching turns that into a false "no data" —
    // a wrong answer rather than a missing one.
    const entry = { service: "order-lookup-service", uptime: 0.9995 };
    expect(entryMatchesService(entry, "OrderLookupService")).toBe(true);
  });

  it.each(["service", "serviceName", "component", "name"])(
    "looks at the %s key",
    (key) => {
      expect(entryMatchesService({ [key]: "Inventory-Check" }, "inventoryCheck")).toBe(true);
    },
  );

  it("does not match a different service", () => {
    expect(entryMatchesService({ service: "OrderLookupService" }, "PaymentGateway")).toBe(false);
  });

  it("does not match an empty name against everything", () => {
    expect(entryMatchesService({}, "")).toBe(false);
  });

  it("returns null when no entry matches", () => {
    expect(selectServiceEntry([{ service: "A" }], "B")).toBeNull();
  });
});

describe("monitoring tools", () => {
  const source = (overrides: Partial<MonitoringSource> = {}): MonitoringSource => ({
    health: async () => null,
    traffic: async () => null,
    ...overrides,
  });

  it("reports absent operational data as a successful, plain answer", async () => {
    // This is the normal code-only case, and returning an error here is what
    // would push the model toward inventing numbers.
    const { checkApiHealth } = createMonitoringTools(source());
    const result = await checkApiHealth.run({ serviceName: "OrderLookupService" }, context);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No health data found for service: OrderLookupService");
    expect(result.content).toContain("rests on static code and log evidence");
  });

  it("returns the payload as readable JSON when data exists", async () => {
    const { checkApiHealth } = createMonitoringTools(
      source({ health: async () => ({ service: "A", uptime30d: 0.9987, incidents: [] }) }),
    );
    const result = await checkApiHealth.run({ serviceName: "A" }, context);

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ uptime30d: 0.9987 });
  });

  it("keeps health and traffic lookups distinct", async () => {
    const tools = createMonitoringTools(
      source({
        health: async () => ({ kind: "health" }),
        traffic: async () => ({ kind: "traffic" }),
      }),
    );

    expect(JSON.parse((await tools.checkApiHealth.run({ serviceName: "A" }, context)).content).kind).toBe("health");
    expect(JSON.parse((await tools.getTrafficStats.run({ serviceName: "A" }, context)).content).kind).toBe("traffic");
  });

  it("reports a failing operational source as tool text", async () => {
    const { getTrafficStats } = createMonitoringTools(
      source({
        traffic: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    const result = await getTrafficStats.run({ serviceName: "A" }, context);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("connection refused");
  });

  it("rejects a missing service name", async () => {
    const { checkApiHealth } = createMonitoringTools(source());
    expect((await checkApiHealth.run({ serviceName: "" }, context)).ok).toBe(false);
  });
});

describe("tool sharing", () => {
  it("gives every agent its tools from one shared instance", () => {
    // The plan's claim is that agents *share* tool implementations rather than
    // each having their own. Identity is the assertion: the same objects, not
    // equivalent ones.
    const tools = createSharedTools({
      knowledge: { answer: async () => ({ answer: "", citations: [], candidatesUsed: 0, candidatesRetrieved: 0 }) },
      monitoring: { health: async () => null, traffic: async () => null },
    });

    expect(toolsFor(tools, "architecture")[0]).toBe(tools.knowledgeBase);
    expect(toolsFor(tools, "risk")).toContain(tools.knowledgeBase);
    // The same knowledge-base object reaches both agents.
    expect(toolsFor(tools, "architecture")[0]).toBe(toolsFor(tools, "risk")[0]);
  });

  it("gives Discovery the knowledge base but not the operational tools", () => {
    // Discovery is building an inventory; inventing a risk judgement from traffic
    // numbers at that stage would be premature.
    const tools = createSharedTools({
      knowledge: { answer: async () => ({ answer: "", citations: [], candidatesUsed: 0, candidatesRetrieved: 0 }) },
      monitoring: { health: async () => null, traffic: async () => null },
    });

    expect(toolsFor(tools, "discovery").map((tool) => tool.name)).toEqual(["queryKnowledgeBase"]);
  });

  it("gives Risk the operational tools as well as the knowledge base", () => {
    const tools = createSharedTools({
      knowledge: { answer: async () => ({ answer: "", citations: [], candidatesUsed: 0, candidatesRetrieved: 0 }) },
      monitoring: { health: async () => null, traffic: async () => null },
    });

    expect(toolsFor(tools, "risk").map((tool) => tool.name)).toEqual([
      "queryKnowledgeBase",
      "checkApiHealth",
      "getTrafficStats",
    ]);
  });

  it("gives Comparison no tools at all", () => {
    // It evaluates the analysis; retrieval would let it rewrite what it grades.
    const tools = createSharedTools({
      knowledge: { answer: async () => ({ answer: "", citations: [], candidatesUsed: 0, candidatesRetrieved: 0 }) },
      monitoring: { health: async () => null, traffic: async () => null },
    });

    expect(toolsFor(tools, "comparison")).toEqual([]);
    expect(Object.keys(TOOLS_BY_AGENT)).toEqual(["discovery", "architecture", "risk", "comparison"]);
  });
});

describe("oneStringArgument", () => {
  it("produces a schema the model can call correctly", () => {
    expect(oneStringArgument("question", "the question")).toEqual({
      type: "object",
      properties: { question: { type: "string", description: "the question" } },
      required: ["question"],
      additionalProperties: false,
    });
  });
});
