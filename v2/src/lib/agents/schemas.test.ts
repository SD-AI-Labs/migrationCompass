import { describe, expect, it } from "vitest";

import {
  AgentOutputError,
  architectureOutputSchema,
  discoveryOutputSchema,
  extractJsonObject,
  normalizeDependencies,
  normalizeDependencyType,
  parseAgentOutput,
  riskAssessmentSchema,
} from "./schemas";
import { discoveryJson } from "./testing/fake-model";

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("reads through a code fence", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("reads through surrounding prose", () => {
    expect(extractJsonObject('Here is the JSON you asked for:\n{"a":1}\nHope that helps!')).toBe(
      '{"a":1}',
    );
  });

  it("handles nested objects", () => {
    expect(extractJsonObject('prefix {"a":{"b":{"c":1}}} suffix')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("is not fooled by braces inside string values", () => {
    // A naive depth counter that ignores string state ends the object early here,
    // producing JSON that fails to parse for reasons that look unrelated.
    const raw = '{"text":"a } brace and a { brace"}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("is not fooled by escaped quotes inside strings", () => {
    const raw = '{"text":"he said \\"}\\" loudly"}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it("returns null when there is no object at all", () => {
    expect(extractJsonObject("I cannot help with that.")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });

  it("returns null for an unterminated object", () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe("parseAgentOutput", () => {
  it("parses and validates a good response", () => {
    const parsed = parseAgentOutput(discoveryJson(), discoveryOutputSchema, "discovery");
    expect(parsed.services).toHaveLength(2);
    expect(parsed.services[0]?.name).toBe("OrderLookupService");
  });

  it("rejects a response with no JSON, naming the step", () => {
    try {
      parseAgentOutput("plain prose", discoveryOutputSchema, "discovery structured output");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentOutputError);
      expect((error as AgentOutputError).label).toBe("discovery structured output");
      expect((error as AgentOutputError).message).toContain("no JSON object");
    }
  });

  it("rejects malformed JSON", () => {
    expect(() => parseAgentOutput('{"a":}', discoveryOutputSchema, "discovery")).toThrowError(
      /did not parse/,
    );
  });

  it("names the failing fields when validation fails", () => {
    // The message is sent back to the model verbatim on the bounded retry, so it
    // has to name the field rather than saying "invalid".
    const missing = JSON.stringify({ summary: "x", services: [{ name: "A", riskLevel: "high" }] });
    try {
      parseAgentOutput(missing, discoveryOutputSchema, "discovery");
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as AgentOutputError).message;
      expect(message).toContain("failed validation");
      expect(message).toContain("services.0");
    }
  });

  it("rejects an unknown enum value rather than coercing it", () => {
    const bad = JSON.stringify({
      summary: "x",
      services: [
        {
          name: "A",
          riskLevel: "catastrophic",
          hasTestCoverageGap: false,
          dataQualityIssueCount: 0,
          requiresMajorRestructuring: false,
        },
      ],
    });
    expect(() => parseAgentOutput(bad, discoveryOutputSchema, "discovery")).toThrowError(
      /failed validation/,
    );
  });

  it("includes a bounded excerpt so a failure is diagnosable", () => {
    try {
      parseAgentOutput("x".repeat(5000), discoveryOutputSchema, "discovery");
      throw new Error("expected a throw");
    } catch (error) {
      const excerpt = (error as AgentOutputError).excerpt;
      expect(excerpt.length).toBeLessThanOrEqual(401);
    }
  });

  it("applies defaults for omitted optional collections", () => {
    const minimal = JSON.stringify({
      summary: "Only a summary and one service.",
      services: [
        {
          name: "A",
          riskLevel: "medium",
          hasTestCoverageGap: true,
          dataQualityIssueCount: 3,
          requiresMajorRestructuring: false,
        },
      ],
    });
    const parsed = parseAgentOutput(minimal, discoveryOutputSchema, "discovery");
    expect(parsed.dependencies).toEqual([]);
    expect(parsed.techStack).toEqual([]);
  });
});

describe("normalizeDependencyType", () => {
  it.each([
    ["synchronous call", "sync_call"],
    ["sync-call", "sync_call"],
    ["SyncCall", "sync_call"],
    ["REST request", "sync_call"],
    ["gRPC", "sync_call"],
    ["async event", "async_event"],
    ["asynchronous message", "async_event"],
    ["message queue", "async_event"],
    ["JMS", "async_event"],
    ["publishes to topic", "async_event"],
    ["shared database", "shared_db"],
    ["shares table", "shared_db"],
    ["same Oracle schema", "shared_db"],
  ])("maps %s → %s", (input, expected) => {
    expect(normalizeDependencyType(input)).toBe(expected);
  });

  it("maps anything unrecognised to unknown rather than dropping it", () => {
    // A dropped edge is a missing edge in the dependency graph, and therefore a
    // wrong risk weight. `unknown` keeps the edge.
    expect(normalizeDependencyType("something else entirely")).toBe("unknown");
    expect(normalizeDependencyType("")).toBe("unknown");
    expect(normalizeDependencyType(null)).toBe("unknown");
  });
});

describe("dependency schema transform", () => {
  const parse = (dependencies: unknown[]) =>
    parseAgentOutput(
      JSON.stringify({
        summary: "summary",
        services: [
          {
            name: "A",
            riskLevel: "low",
            hasTestCoverageGap: false,
            dataQualityIssueCount: 0,
            requiresMajorRestructuring: false,
          },
        ],
        dependencies,
      }),
      discoveryOutputSchema,
      "discovery",
    );

  it("normalizes a model's phrasing into the column's vocabulary", () => {
    const parsed = parse([{ from: "A", to: "B", type: "synchronous call" }]);
    expect(parsed.dependencies[0]?.type).toBe("sync_call");
  });

  it("classifies an external call by destination, not mechanism", () => {
    // "synchronous call to a third-party API" is an external integration; drawing
    // it as an internal sync edge would put a vendor outside the system boundary.
    const parsed = parse([{ from: "A", to: "VendorApi", type: "external synchronous call" }]);
    expect(parsed.dependencies[0]?.type).toBe("external_api");
  });

  it("keeps the evidence text when the model supplies it", () => {
    const parsed = parse([
      { from: "A", to: "B", type: "shared database", evidence: "both read ORDERS table" },
    ]);
    expect(parsed.dependencies[0]?.evidence).toBe("both read ORDERS table");
  });

  it("accepts an edge with no type at all, as unknown", () => {
    const parsed = parse([{ from: "A", to: "B" }]);
    expect(parsed.dependencies[0]?.type).toBe("unknown");
  });
});

describe("normalizeDependencies", () => {
  const edge = (from: string, to: string, type: "sync_call" | "shared_db" = "sync_call") => ({
    from,
    to,
    type,
    evidence: undefined,
  });

  it("drops self-edges, which are not dependencies", () => {
    expect(normalizeDependencies([edge("A", "A")])).toEqual([]);
  });

  it("drops exact duplicates, which would double-count in the risk weight", () => {
    expect(normalizeDependencies([edge("A", "B"), edge("A", "B")])).toHaveLength(1);
  });

  it("keeps the same pair when the relationship type differs", () => {
    // Calling a service and sharing its database are two different couplings.
    expect(normalizeDependencies([edge("A", "B", "sync_call"), edge("A", "B", "shared_db")])).toHaveLength(2);
  });

  it("preserves the order of the first occurrence", () => {
    const normalized = normalizeDependencies([edge("A", "B"), edge("C", "D"), edge("A", "B")]);
    expect(normalized.map((item) => `${item.from}->${item.to}`)).toEqual(["A->B", "C->D"]);
  });
});

describe("risk assessment schema", () => {
  it("defaults an unstated evidence source to static analysis", () => {
    const parsed = parseAgentOutput(
      JSON.stringify({
        ranked: [{ serviceName: "A", riskLevel: "high", reasoning: "no tests" }],
      }),
      riskAssessmentSchema,
      "risk",
    );
    expect(parsed.ranked[0]?.evidenceSource).toBe("static_analysis");
  });

  it("requires at least one ranked service", () => {
    // An empty ranking is a failure, not an empty assessment: the Risk Agent was
    // given a service inventory and produced nothing about any of it.
    expect(() =>
      parseAgentOutput(JSON.stringify({ ranked: [] }), riskAssessmentSchema, "risk"),
    ).toThrowError(/failed validation/);
  });
});

describe("architecture schema", () => {
  it("requires an explicit statement about whether the current architecture is sound", () => {
    // The plan asks for this as a stated finding, not an inference from silence —
    // it is an input to the readiness score.
    expect(() =>
      parseAgentOutput(
        JSON.stringify({ migrationApproach: "strangler fig" }),
        architectureOutputSchema,
        "architecture",
      ),
    ).toThrowError(/failed validation/);
  });
});
