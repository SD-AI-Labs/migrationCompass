import { describe, expect, it } from "vitest";

import {
  EDGE_TYPE_LABELS,
  NODE_HEIGHT,
  NODE_WIDTH,
  RISK_COLORS,
  buildDependencyGraph,
  canvasSizeFor,
  edgeLabelFor,
  findCycles,
  nodeIdFor,
  riskLevelsPresent,
  type GraphDependencyInput,
  type GraphServiceInput,
} from "./build-graph";
import {
  loadSampleFixtureExpectation,
  sampleFixtureDependencies,
  sampleFixtureGraphServices,
} from "@/lib/testing/sample-fixture";

function service(serviceName: string, riskLevel: GraphServiceInput["riskLevel"] = "medium"): GraphServiceInput {
  return { serviceName, riskLevel };
}

function edge(from: string, to: string, type = "sync_call"): GraphDependencyInput {
  return { fromService: from, toService: to, type };
}

describe("buildDependencyGraph", () => {
  it("returns an empty model for empty input", () => {
    const model = buildDependencyGraph({ services: [], dependencies: [] });

    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.cycles).toEqual([]);
    expect(model.isolated).toEqual([]);
    expect(model.suppressedEdges).toBe(0);
    expect(model.edgeTypes).toEqual([]);
    // Still gives the container a usable size rather than collapsing to zero.
    expect(canvasSizeFor(model).width).toBeGreaterThan(0);
    expect(canvasSizeFor(model).height).toBeGreaterThan(0);
  });

  it("draws a single service with no dependencies as an isolated node", () => {
    const model = buildDependencyGraph({
      services: [service("only-service", "low")],
      dependencies: [],
    });

    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]).toMatchObject({
      id: "only-service",
      label: "only-service",
      riskLevel: "low",
      incoming: 0,
      outgoing: 0,
      depth: 0,
      unknownRisk: false,
    });
    expect(model.edges).toEqual([]);
    expect(model.isolated).toEqual(["only-service"]);
  });

  it("lays out fan-out one layer to the right of its source", () => {
    const model = buildDependencyGraph({
      services: [service("core", "high"), service("left", "low"), service("right", "medium")],
      dependencies: [edge("core", "left"), edge("core", "right")],
    });

    const core = model.nodes.find((node) => node.id === "core");
    const left = model.nodes.find((node) => node.id === "left");
    const right = model.nodes.find((node) => node.id === "right");

    expect(core).toMatchObject({ outgoing: 2, incoming: 0, depth: 0 });
    expect(left).toMatchObject({ incoming: 1, outgoing: 0, depth: 1 });
    expect(right).toMatchObject({ incoming: 1, outgoing: 0, depth: 1 });
    // Same column (same depth) but different rows, so the two boxes do not overlap.
    expect(left?.x).toBe(right?.x);
    expect(left?.y).not.toBe(right?.y);
    expect(model.isolated).toEqual([]);
  });

  it("counts fan-in without losing the sources", () => {
    const model = buildDependencyGraph({
      services: [service("a"), service("b"), service("sink")],
      dependencies: [edge("a", "sink"), edge("b", "sink")],
    });

    const sink = model.nodes.find((node) => node.id === "sink");
    expect(sink).toMatchObject({ incoming: 2, outgoing: 0, depth: 1 });
    expect(model.nodes.find((node) => node.id === "a")?.depth).toBe(0);
    expect(model.nodes.find((node) => node.id === "b")?.depth).toBe(0);
  });

  it("carries the edge type through to the rendered edge and legend", () => {
    const model = buildDependencyGraph({
      services: [service("a"), service("b"), service("c")],
      dependencies: [edge("a", "b", "sync_call"), edge("b", "c", "async_event")],
    });

    expect(model.edgeTypes).toEqual(["async_event", "sync_call"]);
    // Edges are ordered by their stable id (source→target:type), not by input order.
    expect(model.edges.map((item) => item.type)).toEqual(["sync_call", "async_event"]);
    expect(model.edges.every((item) => item.label === edgeLabelFor(item.type))).toBe(true);
    // The label table is pinned separately so a rename here is a deliberate change.
    expect(EDGE_TYPE_LABELS).toMatchObject({
      sync_call: "synchronous call",
      async_event: "async / event",
      shared_db: "shared database",
      external_api: "external API",
      unknown: "unclassified",
    });
    // Edge ids are stable and include the type, so two relationships between the
    // same pair do not collide.
    expect(model.edges.map((item) => item.id)).toEqual(["a->b:sync_call", "b->c:async_event"]);
  });

  it("draws a service known only from an edge as unrated rather than guessing a level", () => {
    const model = buildDependencyGraph({
      services: [service("analysis-run-service", "high")],
      dependencies: [edge("analysis-run-service", "never-analysed-service")],
    });

    const unknown = model.nodes.find((node) => node.id === "never-analysed-service");
    expect(unknown).toMatchObject({ riskLevel: "unknown", unknownRisk: true });
    expect(unknown?.label).toBe("never-analysed-service");
    // The analysed service is untouched.
    expect(model.nodes.find((node) => node.id === "analysis-run-service")?.riskLevel).toBe("high");
  });

  it("keeps the declared risk when names differ only by punctuation", () => {
    const model = buildDependencyGraph({
      services: [service("Payment Service", "critical")],
      dependencies: [edge("payment-service", "gateway", "external_api")],
    });

    // nodeIdFor folds both spellings to one id, and the analysed service's level
    // wins over the "unknown" the edge would otherwise assign.
    const payment = model.nodes.find((node) => node.id === "payment-service");
    expect(payment).toMatchObject({ riskLevel: "critical", unknownRisk: false, label: "Payment Service" });
    expect(model.nodes).toHaveLength(2);
  });

  it("suppresses self-edges, duplicate edges and blank endpoints, and says how many", () => {
    const model = buildDependencyGraph({
      services: [service("a"), service("b")],
      dependencies: [
        edge("a", "b"),
        edge("a", "b"),
        edge("a", "a"),
        edge("b", "b"),
        edge("", "b"),
        edge("a", "   "),
        // A row from before M3's normalization ran: no type recorded.
        { fromService: "c", toService: "d" } as GraphDependencyInput,
      ],
    });

    expect(model.edges.map((item) => item.id)).toEqual(["a->b:sync_call", "c->d:unknown"]);
    expect(model.suppressedEdges).toBe(5);
    // The blank endpoint must not have become a node. Order is (depth, id).
    expect(model.nodes.map((node) => node.id)).toEqual(["a", "c", "b", "d"]);
    expect(model.nodes.some((node) => node.id.trim().length === 0)).toBe(false);
    // A missing type renders as unclassified rather than "undefined" anywhere.
    expect(model.edges.map((item) => item.id).join()).not.toContain("undefined");
    expect(edgeLabelFor("unknown")).toBe("unclassified");
  });

  it("reports a cycle while still drawing every node and edge", () => {
    const model = buildDependencyGraph({
      services: [service("a"), service("b")],
      dependencies: [edge("a", "b"), edge("b", "a")],
    });

    expect(model.cycles).toHaveLength(1);
    expect(model.cycles[0]).toEqual(["a", "b", "a"]);
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(2);
    // A cyclic pair must still get finite positions.
    expect(model.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("is deterministic: the same input produces a byte-identical model", () => {
    const input = {
      services: [service("b", "low"), service("a", "high"), service("c", "medium")],
      dependencies: [edge("a", "b"), edge("a", "c"), edge("c", "b", "shared_db")],
    };

    expect(JSON.stringify(buildDependencyGraph(input))).toBe(
      JSON.stringify(buildDependencyGraph(input)),
    );
    // Order of the input arrays must not matter either — persistence order is not
    // a promise the UI should depend on.
    const shuffled = {
      services: [...input.services].reverse(),
      dependencies: [...input.dependencies].reverse(),
    };
    expect(JSON.stringify(buildDependencyGraph(shuffled))).toBe(
      JSON.stringify(buildDependencyGraph(input)),
    );
  });

  it("lists the risk levels actually present, in documented order", () => {
    const model = buildDependencyGraph({
      services: [service("a", "medium"), service("b", "critical")],
      dependencies: [edge("a", "unrated", "sync_call")],
    });

    expect(riskLevelsPresent(model)).toEqual(["critical", "medium", "unknown"]);
    expect(RISK_COLORS.critical).not.toBe(RISK_COLORS.unknown);
    expect(RISK_COLORS.unknown).toBe("var(--risk-unknown)");
  });

  it("sizes the canvas from the laid-out nodes", () => {
    const model = buildDependencyGraph({
      services: [service("a"), service("b")],
      dependencies: [edge("a", "b")],
    });
    const canvas = canvasSizeFor(model);

    expect(canvas.width).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(canvas.height).toBeGreaterThanOrEqual(NODE_HEIGHT);
  });
});

describe("nodeIdFor", () => {
  it("folds punctuation and case to one id", () => {
    expect(nodeIdFor("Order Service")).toBe("order-service");
    expect(nodeIdFor("order_service")).toBe("order-service");
    expect(nodeIdFor("order-service")).toBe("order-service");
    expect(nodeIdFor("  --Order  Service-- ")).toBe("order-service");
  });

  it("falls back to the raw name when nothing survives normalization", () => {
    expect(nodeIdFor("///")).toBe("///");
  });
});

describe("findCycles", () => {
  it("returns nothing for a DAG", () => {
    expect(findCycles(["a", "b"], new Map([["a", ["b"]], ["b", []]]))).toEqual([]);
  });

  it("reports each back edge as its own cycle path", () => {
    const cycles = findCycles(
      ["a", "b", "c"],
      new Map([
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", ["a"]],
      ]),
    );

    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b", "c", "a"]);
  });
});

describe("the sample fixture graph", () => {
  it("builds the recorded chain, with the external system drawn as unrated", () => {
    const expectation = loadSampleFixtureExpectation();
    const model = buildDependencyGraph({
      services: sampleFixtureGraphServices(),
      dependencies: sampleFixtureDependencies(),
    });

    // Three analysed services, plus the external processor the fixture calls.
    expect(model.nodes).toHaveLength(expectation.services.length + expectation.inventory.external.length);
    expect(model.edges).toHaveLength(expectation.dependencies.length);
    expect(model.suppressedEdges).toBe(0);

    // customer-service → order-service → payment-service → external gateway.
    const depthOf = (id: string) => model.nodes.find((node) => node.id === id)?.depth;
    expect(depthOf("customer-service")).toBe(0);
    expect(depthOf("order-service")).toBe(1);
    expect(depthOf("payment-service")).toBe(2);
    expect(depthOf("external-payment-gateway")).toBe(3);

    // Risk travels with the node; the external system has none to show.
    expect(model.nodes.find((node) => node.id === "payment-service")?.riskLevel).toBe("critical");
    expect(model.nodes.find((node) => node.id === "customer-service")?.riskLevel).toBe("high");
    expect(model.nodes.find((node) => node.id === "external-payment-gateway")).toMatchObject({
      riskLevel: "unknown",
      unknownRisk: true,
    });

    // The external integration is the only non-sync edge, and it is labelled.
    expect(model.edgeTypes).toEqual(["external_api", "sync_call"]);
    expect(model.edges.find((item) => item.type === "external_api")?.label).toBe(
      edgeLabelFor("external_api"),
    );

    expect(model.cycles).toEqual([]);
    // Every analysed service is connected, so nothing is isolated.
    expect(model.isolated).toEqual([]);
  });
});
