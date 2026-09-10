import { describe, expect, it } from "vitest";

import { runAnalysisGraph } from "./graph";
import { describeError } from "./run";
import {
  architectureJson,
  comparisonJson,
  createFakeModel,
  createFakeTools,
  discoveryJson,
  riskJson,
  type FakeScript,
} from "./testing/fake-model";

/**
 * Structural coverage of the graph.
 *
 * These assertions are about *orchestration semantics* — what ran, in what order,
 * how many times, and what each stage could see — not about four functions having
 * been called. The two that carry the real weight:
 *
 *  - the concurrency test, which deadlocks if the branches are serialised
 *  - the fan-in index comparison, which fails if the join node runs per incoming
 *    edge instead of once
 *
 * Markers are embedded in the scripted narratives so "Architecture received
 * Discovery's output" is checked against the actual prompt text rather than
 * inferred from the wiring.
 */

const DISCOVERY_MARKER = "DISCOVERY-MARKER three SOAP services share one Oracle schema";
const ARCHITECTURE_MARKER = "ARCHITECTURE-MARKER strangler fig starting with the read path";
const RISK_MARKER = "RISK-MARKER CustomerAccountService is critical";
const REFINED_RISK_MARKER = "REFINED-RISK-MARKER revised after the critique";
const COMPARISON_MARKER = "COMPARISON-MARKER mostly accurate";

function baseScript(overrides: FakeScript = {}): FakeScript {
  return {
    "discovery.draft": DISCOVERY_MARKER,
    "discovery.critique": "Complete",
    "discovery.extract": discoveryJson(),
    "architecture.draft": ARCHITECTURE_MARKER,
    "architecture.critique": "Complete",
    "architecture.extract": architectureJson(),
    "risk.draft": RISK_MARKER,
    "risk.critique": "Complete",
    "risk.extract": riskJson(),
    "comparison.draft": COMPARISON_MARKER,
    "comparison.extract": comparisonJson(),
    ...overrides,
  };
}

function harness(overrides: FakeScript = {}) {
  const model = createFakeModel(baseScript(overrides));
  const tools = createFakeTools();
  const stageStarts: string[] = [];

  return {
    model,
    tools,
    stageStarts,
    run: () =>
      runAnalysisGraph({
        projectId: "project-1",
        runId: "run-1",
        deps: {
          llm: model.llm,
          tools: tools.tools,
          onStageStart: async (stage) => {
            stageStarts.push(stage);
          },
        },
      }),
  };
}

const indexOfTag = (tags: string[], prefix: string): number[] =>
  tags.map((tag, index) => ({ tag, index })).filter(({ tag }) => tag.startsWith(prefix)).map(({ index }) => index);

describe("graph structure", () => {
  it("runs Discovery first", async () => {
    const { model, run } = harness();
    const outcome = await run();

    // Nothing else may precede it: every other stage's prompt is built from
    // Discovery's output, so a branch starting first would be building on nothing.
    expect(model.calls[0]?.tag).toBe("discovery.draft");
    expect(outcome.completedStages[0]).toBe("discovery");
    expect(model.countOf("discovery.draft")).toBe(1);
  });

  it("gives Architecture the Discovery report", async () => {
    const { model, run } = harness();
    await run();

    const architectureDraft = model.calls.find((call) => call.tag === "architecture.draft");
    expect(architectureDraft?.prompt).toContain(DISCOVERY_MARKER);
  });

  it("gives Risk the Discovery report", async () => {
    const { model, run } = harness();
    await run();

    const riskDraft = model.calls.find((call) => call.tag === "risk.draft");
    expect(riskDraft?.prompt).toContain(DISCOVERY_MARKER);
  });

  it("gives Comparison the Discovery, Architecture and Risk outputs", async () => {
    const { model, run } = harness();
    await run();

    const comparisonDraft = model.calls.find((call) => call.tag === "comparison.draft");
    expect(comparisonDraft?.prompt).toContain(DISCOVERY_MARKER);
    expect(comparisonDraft?.prompt).toContain(ARCHITECTURE_MARKER);
    expect(comparisonDraft?.prompt).toContain(RISK_MARKER);
  });

  it("executes neither branch twice", async () => {
    const { model, run } = harness();
    const outcome = await run();

    expect(model.countOf("architecture.draft")).toBe(1);
    expect(model.countOf("risk.draft")).toBe(1);
    expect(outcome.completedStages.filter((stage) => stage === "architecture")).toHaveLength(1);
    expect(outcome.completedStages.filter((stage) => stage === "risk")).toHaveLength(1);
  });
});

describe("fan-out and fan-in", () => {
  it("finishes both branches before Comparison starts", async () => {
    const { model, run } = harness();
    const outcome = await run();
    const tags = model.calls.map((call) => call.tag);

    const branchIndexes = [...indexOfTag(tags, "architecture."), ...indexOfTag(tags, "risk.")];
    const comparisonIndexes = indexOfTag(tags, "comparison.");

    expect(branchIndexes.length).toBeGreaterThan(0);
    expect(comparisonIndexes.length).toBeGreaterThan(0);
    // Every branch call precedes every comparison call — the join genuinely waits.
    expect(Math.max(...branchIndexes)).toBeLessThan(Math.min(...comparisonIndexes));

    // And the graph's own completion record agrees.
    expect(outcome.completedStages.at(-1)).toBe("comparison");
    expect(outcome.completedStages.indexOf("comparison")).toBeGreaterThan(
      outcome.completedStages.indexOf("architecture"),
    );
    expect(outcome.completedStages.indexOf("comparison")).toBeGreaterThan(
      outcome.completedStages.indexOf("risk"),
    );
  });

  it("runs Architecture and Risk concurrently, not sequentially", async () => {
    // The rendezvous that makes this a real assertion: Architecture refuses to
    // produce its report until Risk has started. If the graph serialised the
    // branches, Architecture would wait for a signal that can never arrive, the
    // timeout below would fire, and the run would fail with a deadlock message.
    let signalRiskStarted: () => void = () => {};
    const riskStarted = new Promise<void>((resolve) => {
      signalRiskStarted = resolve;
    });

    const { model, run } = harness({
      "architecture.draft": async () => {
        await withDeadline(riskStarted, "Risk never started while Architecture was running");
        return ARCHITECTURE_MARKER;
      },
      "risk.draft": async () => {
        signalRiskStarted();
        return RISK_MARKER;
      },
    });

    const outcome = await run();

    expect(outcome.architecture.narrative).toBe(ARCHITECTURE_MARKER);
    expect(outcome.risk.narrative).toBe(RISK_MARKER);
    expect(model.countOf("architecture.draft")).toBe(1);
    expect(model.countOf("risk.draft")).toBe(1);
  });

  it("does not run the join node once per incoming edge", async () => {
    // Two edges lead into Comparison. If the framework fired it per predecessor,
    // it would run twice and the extra pass would be visible here.
    const { model, run } = harness();
    await run();

    expect(model.countOf("comparison.draft")).toBe(1);
    expect(model.countOf("comparison.extract")).toBe(1);
  });
});

describe("bounded refinement inside the graph", () => {
  it("does not refine a stage whose first critique says complete", async () => {
    const { model, run } = harness();
    await run();

    expect(model.countOf("discovery.critique")).toBe(1);
    expect(model.countOf("discovery.refine")).toBe(0);
  });

  it("refines exactly once when the critique finds gaps, and never critiques again", async () => {
    const { model, run } = harness({
      "risk.critique": "Complete except the payment integration was not checked",
      "risk.refine": REFINED_RISK_MARKER,
    });

    const outcome = await run();

    expect(model.countOf("risk.refine")).toBe(1);
    expect(model.countOf("risk.critique")).toBe(1);
    // The refinement's output is what the stage reports.
    expect(outcome.risk.narrative).toBe(REFINED_RISK_MARKER);
    expect(outcome.risk.wasRefined).toBe(true);
  });

  it("treats 'Complete except…' as a gap rather than approval, end to end", async () => {
    const { model, run } = harness({
      "architecture.critique": "Complete except the messaging layer was skipped",
      "architecture.refine": "ARCHITECTURE-MARKER revised",
    });

    const outcome = await run();

    expect(outcome.architecture.wasRefined).toBe(true);
    expect(model.countOf("architecture.refine")).toBe(1);
  });

  it("counts each critique exactly once across the whole run", async () => {
    // Three critiqued stages, one critique call each — no stage is critiqued twice
    // no matter what its refinement produced, which is the one-round bound seen
    // from the outside.
    const { model, run } = harness({
      "discovery.critique": "Missing the dependency edges",
      "discovery.refine": "DISCOVERY-MARKER revised",
      "risk.critique": "Missing the payment integration",
      "risk.refine": REFINED_RISK_MARKER,
    });

    await run();

    expect(model.countOf("discovery.critique")).toBe(1);
    expect(model.countOf("discovery.refine")).toBe(1);
    expect(model.countOf("architecture.critique")).toBe(1);
    expect(model.countOf("architecture.refine")).toBe(0);
    expect(model.countOf("risk.critique")).toBe(1);
    expect(model.countOf("risk.refine")).toBe(1);
  });
});

describe("structured extraction", () => {
  it("validates each stage's output and exposes it in the outcome", async () => {
    const { run } = harness();
    const outcome = await run();

    expect(outcome.discovery.structured.services.map((service) => service.name)).toEqual([
      "OrderLookupService",
      "CustomerAccountService",
    ]);
    expect(outcome.architecture.structured.currentArchitectureLargelySound).toBe(false);
    expect(outcome.risk.structured.ranked).toHaveLength(3);
    expect(outcome.comparison.structured.accuracyAssessment.length).toBeGreaterThan(0);
  });

  it("normalizes and de-duplicates dependencies before they leave the graph", async () => {
    const { run } = harness();
    const outcome = await run();

    // The fixture contains a duplicate shared-database edge.
    const edges = outcome.discovery.structured.dependencies;
    expect(edges).toHaveLength(2);
    expect(edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`)).toEqual([
      "CustomerAccountService->PostalVerificationApi:sync_call",
      "PartnerCatalogFeed->InventoryCheckService:shared_db",
    ]);
  });

  it("retries a failed extraction once, feeding the validator's own message back", async () => {
    const { model, run } = harness({
      "discovery.extract": "this is not JSON at all",
      "discovery.extract-retry": discoveryJson(),
    });

    const outcome = await run();

    expect(model.countOf("discovery.extract")).toBe(1);
    expect(model.countOf("discovery.extract-retry")).toBe(1);
    const retry = model.calls.find((call) => call.tag === "discovery.extract-retry");
    expect(retry?.prompt).toContain("no JSON object");
    expect(outcome.discovery.structured.services.length).toBeGreaterThan(0);
  });

  it("fails the stage when the retry is also invalid, rather than guessing", async () => {
    const { model, run } = harness({
      "discovery.extract": "not JSON",
      "discovery.extract-retry": "still not JSON",
    });

    await expect(run()).rejects.toThrow(/discovery structured output/);
    // Bounded: two attempts, not an open-ended re-prompt loop.
    expect(model.countOf("discovery.extract")).toBe(1);
    expect(model.countOf("discovery.extract-retry")).toBe(1);
  });
});

describe("shared tools inside the graph", () => {
  it("hands the same tool instances to more than one agent", async () => {
    const model = createFakeModel(
      baseScript({
        "architecture.draft": [
          { content: "", toolCalls: [{ name: "queryKnowledgeBase", arguments: '{"question":"arch question"}' }] },
          ARCHITECTURE_MARKER,
        ],
        "risk.draft": [
          {
            content: "",
            toolCalls: [
              { name: "queryKnowledgeBase", arguments: '{"question":"risk question"}' },
              { name: "checkApiHealth", arguments: '{"serviceName":"CustomerAccountService"}' },
            ],
          },
          RISK_MARKER,
        ],
      }),
    );
    const tools = createFakeTools();

    await runAnalysisGraph({
      projectId: "project-1",
      runId: "run-1",
      deps: { llm: model.llm, tools: tools.tools },
    });

    const knowledgeInvocations = tools.invocations.filter((invocation) => invocation.tool === "knowledgeBase");
    // Both branches used the knowledge base...
    expect(knowledgeInvocations).toHaveLength(2);
    // ...and it was the same object both times, not two equivalent ones.
    expect(knowledgeInvocations[0]?.instance).toBe(tools.tools.knowledgeBase);
    expect(knowledgeInvocations[1]?.instance).toBe(tools.tools.knowledgeBase);

    // The risk agent's operational tool came from the shared set as well.
    expect(tools.invocations.find((invocation) => invocation.tool === "checkApiHealth")?.instance).toBe(
      tools.tools.checkApiHealth,
    );
  });

  it("scopes every tool call to the run's project", async () => {
    const model = createFakeModel(
      baseScript({
        "risk.draft": [
          { content: "", toolCalls: [{ name: "checkApiHealth", arguments: '{"serviceName":"A"}' }] },
          RISK_MARKER,
        ],
      }),
    );
    const tools = createFakeTools();

    await runAnalysisGraph({
      projectId: "project-77",
      runId: "run-88",
      deps: { llm: model.llm, tools: tools.tools },
    });

    expect(tools.invocations.length).toBeGreaterThan(0);
    for (const invocation of tools.invocations) {
      expect(invocation.context).toEqual({ projectId: "project-77", runId: "run-88" });
    }
  });
});

describe("failure semantics", () => {
  it("propagates a branch failure instead of continuing to the join", async () => {
    const { model, run } = harness({ "risk.draft": new Error("risk model exploded") });

    await expect(run()).rejects.toThrow(/risk model exploded/);
    // Comparison must not have run: it consumes Risk's output, so completing the
    // graph without it would produce a comparison of nothing.
    expect(model.countOf("comparison.draft")).toBe(0);
  });

  it("surfaces a Discovery failure before any branch starts", async () => {
    const { model, run } = harness({ "discovery.draft": new Error("discovery model exploded") });

    await expect(run()).rejects.toThrow(/discovery model exploded/);
    expect(model.countOf("architecture.draft")).toBe(0);
    expect(model.countOf("risk.draft")).toBe(0);
  });

  it("keeps the underlying message readable through the framework's wrapping", async () => {
    // LangGraph wraps a node failure, so the message that explains what happened
    // lives one level down in `cause`. Persisting only the wrapper would produce
    // run records that say "node failed" and nothing else.
    const { run } = harness({ "risk.draft": new Error("risk model exploded") });

    try {
      await run();
      throw new Error("expected the run to fail");
    } catch (error) {
      expect(describeError(error)).toContain("risk model exploded");
    }
  });

  it("stops a stage that hits its tool-call ceiling without answering", async () => {
    const { run } = harness({
      "risk.draft": { content: "", toolCalls: [{ name: "checkApiHealth", arguments: '{"serviceName":"A"}' }] },
    });

    // Every turn asks for another tool, so the loop is cut off with no report.
    await expect(run()).rejects.toThrow(/tool-call limit/);
  });
});

describe("stage transitions", () => {
  it("reports each stage starting exactly once, in dependency order", async () => {
    const { stageStarts, run } = harness();
    await run();

    expect(stageStarts.filter((stage) => stage === "discovery")).toHaveLength(1);
    expect(stageStarts.filter((stage) => stage === "architecture")).toHaveLength(1);
    expect(stageStarts.filter((stage) => stage === "risk")).toHaveLength(1);
    expect(stageStarts.filter((stage) => stage === "comparison")).toHaveLength(1);

    // Discovery is announced before either branch; both branches before the join.
    expect(stageStarts[0]).toBe("discovery");
    expect(stageStarts.indexOf("comparison")).toBeGreaterThan(stageStarts.indexOf("architecture"));
    expect(stageStarts.indexOf("comparison")).toBeGreaterThan(stageStarts.indexOf("risk"));
  });
});

/** Rejects if `signal` does not settle first — the deadlock detector for the concurrency test. */
async function withDeadline(signal: Promise<void>, message: string, ms = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLOCK: ${message}`)), ms);
  });

  try {
    await Promise.race([signal, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
