import { RISK_LEVELS, type RiskLevel } from "@/lib/scoring/assumptions";

/**
 * Dependency graph construction, as pure data.
 *
 * Kept out of the React component on purpose: the interesting behaviour is
 * structural — how a cycle is handled, how a node with no edges is placed, how a
 * duplicate edge is suppressed — and that is testable here without a renderer.
 * The component receives a finished model and only draws it.
 *
 * The input is the M3 persisted contract: typed edges between named services.
 * Nothing in this module reads source files or infers relationships; the edges it
 * draws are exactly the edges the analysis recorded.
 */

export type GraphRiskLevel = RiskLevel | "unknown";

export type GraphServiceInput = {
  serviceName: string;
  riskLevel: RiskLevel;
  /** Distinct dependents, from the persisted finding. */
  dependentCount?: number;
};

export type GraphDependencyInput = {
  fromService: string;
  toService: string;
  type: string;
};

export type DependencyGraphNode = {
  id: string;
  label: string;
  riskLevel: GraphRiskLevel;
  /** Edges pointing at this node. */
  incoming: number;
  /** Edges leaving this node. */
  outgoing: number;
  /** Layer in the layout: 0 for a service nothing else depends on being reached first. */
  depth: number;
  x: number;
  y: number;
  /** True when the service appears in an edge but not in the findings. */
  unknownRisk: boolean;
};

export type DependencyGraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
};

export type DependencyGraphModel = {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  /** Services with no edges at all — rendered, but called out. */
  isolated: string[];
  /** Every cycle found, as a list of node ids. Empty for a healthy graph. */
  cycles: string[][];
  /** Self-edges and duplicate edges dropped before layout. */
  suppressedEdges: number;
  /** Edge types actually present, for a legend. */
  edgeTypes: string[];
};

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 72;
const COLUMN_GAP = 280;
const ROW_GAP = 120;

/** Human labels for the persisted `dependency_type` values. */
export const EDGE_TYPE_LABELS: Record<string, string> = {
  sync_call: "synchronous call",
  async_event: "async / event",
  shared_db: "shared database",
  external_api: "external API",
  unknown: "unclassified",
};

export const RISK_COLORS: Record<GraphRiskLevel, string> = {
  // The theme's tokens, referenced rather than copied: this palette is the same
  // one the scorecard's badges use, and a second literal copy of it would drift
  // the first time a colour changes.
  critical: "var(--risk-critical)",
  high: "var(--risk-high)",
  medium: "var(--risk-medium)",
  low: "var(--risk-low)",
  unknown: "var(--risk-unknown)",
};

export function edgeLabelFor(type: string): string {
  return EDGE_TYPE_LABELS[type] ?? EDGE_TYPE_LABELS.unknown ?? "unclassified";
}

/**
 * Normalizes a service name into a node id.
 *
 * Two edges naming the same service differently ("order-service" and
 * "OrderService") must land on one node — otherwise the graph shows a coupling
 * that does not exist and the risk colouring splits one service across two boxes.
 */
export function nodeIdFor(serviceName: string): string {
  const normalized = serviceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : serviceName;
}

/**
 * Drops self-edges and duplicate edges.
 *
 * Mirrors the M3 persisted contract rather than trusting it: M3 normalizes before
 * writing, and this repeats the rule at the render boundary so a row that predates
 * that normalization cannot draw a service pointing at itself.
 */
function normalizeEdges(edges: GraphDependencyInput[]): {
  edges: GraphDependencyInput[];
  suppressed: number;
} {
  const seen = new Set<string>();
  const normalized: GraphDependencyInput[] = [];
  let suppressed = 0;

  for (const edge of edges) {
    const from = nodeIdFor(edge.fromService);
    const to = nodeIdFor(edge.toService);
    // A blank endpoint is not a relationship. Without this the row was kept, the
    // blank name became a real node id, and the graph drew an edge into a service
    // that does not exist.
    if (edge.fromService.trim().length === 0 || edge.toService.trim().length === 0) {
      suppressed += 1;
      continue;
    }
    if (from === to) {
      suppressed += 1;
      continue;
    }
    // Unclassified rather than "undefined": M3 stores `unknown` for a relationship
    // it could not type, and a row with no type at all should render the same way
    // rather than producing an `id: "…->…:undefined"`.
    const type = typeof edge.type === "string" && edge.type.length > 0 ? edge.type : "unknown";
    const key = `${from}\u0000${to}\u0000${type}`;
    if (seen.has(key)) {
      suppressed += 1;
      continue;
    }
    seen.add(key);
    normalized.push({ fromService: edge.fromService, toService: edge.toService, type });
  }

  return { edges: normalized, suppressed };
}

/** Depth-first search over the normalized edge set, reporting back edges as cycles. */
export function findCycles(
  nodeIds: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const cycles: string[][] = [];
  const stack: string[] = [];

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      if (colour.get(next) === GREY) {
        // A back edge: the stack from `next` onward is the cycle.
        const start = stack.indexOf(next);
        if (start >= 0) cycles.push([...stack.slice(start), next]);
        continue;
      }
      if (colour.get(next) === WHITE) visit(next);
    }

    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of nodeIds) {
    if (colour.get(node) === WHITE) visit(node);
  }

  return cycles;
}

/**
 * Layers nodes by longest path from a source, cycle-safely.
 *
 * Kahn's algorithm peels off nodes whose dependencies are all placed; anything
 * left over sits in a cycle and would never be placed, so it is appended to the
 * deepest layer instead of being dropped from the diagram. A layout that silently
 * omits a service would be worse than one that draws it awkwardly.
 */
function assignDepths(nodeIds: string[], edges: GraphDependencyInput[]): Map<string, number> {
  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(nodeIds.map((id) => [id, []]));

  for (const edge of edges) {
    const from = nodeIdFor(edge.fromService);
    const to = nodeIdFor(edge.toService);
    if (from === to) continue;
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    outgoing.get(from)?.push(to);
  }

  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const placed = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift() as string;
    placed.add(node);
    for (const next of outgoing.get(node) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(node) ?? 0) + 1));
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const unplaced = nodeIds.filter((id) => !placed.has(id));
  if (unplaced.length > 0) {
    const deepest = Math.max(...nodeIds.map((id) => depth.get(id) ?? 0), 0);
    const cycleDepth = deepest + 1;
    for (const id of unplaced) depth.set(id, cycleDepth);
  }

  return depth;
}

/**
 * Builds the renderable model.
 *
 * Deterministic: nodes and edges are sorted, so the same persisted rows always
 * produce the same layout — which is what makes the fixture test meaningful and
 * the screenshot reproducible.
 */
export function buildDependencyGraph(input: {
  services: GraphServiceInput[];
  dependencies: GraphDependencyInput[];
}): DependencyGraphModel {
  const { edges: normalizedEdges, suppressed } = normalizeEdges(input.dependencies);

  const riskByNode = new Map<string, GraphRiskLevel>();
  const labelByNode = new Map<string, string>();
  const dependentsByNode = new Map<string, number>();

  for (const service of input.services) {
    const id = nodeIdFor(service.serviceName);
    // A service listed in the findings keeps its declared risk even if the name
    // normalization merged it with another spelling.
    if (!riskByNode.has(id) || riskByNode.get(id) === "unknown") {
      riskByNode.set(id, service.riskLevel);
      labelByNode.set(id, service.serviceName);
    }
    dependentsByNode.set(id, Math.max(dependentsByNode.get(id) ?? 0, service.dependentCount ?? 0));
  }

  for (const edge of normalizedEdges) {
    for (const name of [edge.fromService, edge.toService]) {
      const id = nodeIdFor(name);
      if (!riskByNode.has(id)) {
        // Reachable only through an edge: drawn, but visibly unrated rather than
        // quietly coloured as if it had been assessed.
        riskByNode.set(id, "unknown");
        labelByNode.set(id, name);
      }
    }
  }

  const nodeIds = [...riskByNode.keys()].sort();
  const depth = assignDepths(nodeIds, normalizedEdges);

  const incoming = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));

  for (const edge of normalizedEdges) {
    const from = nodeIdFor(edge.fromService);
    const to = nodeIdFor(edge.toService);
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    adjacency.get(from)?.push(to);
  }

  const byDepth = new Map<number, string[]>();
  for (const id of nodeIds) {
    const layer = depth.get(id) ?? 0;
    const bucket = byDepth.get(layer) ?? [];
    bucket.push(id);
    byDepth.set(layer, bucket);
  }

  const nodes: DependencyGraphNode[] = [];
  for (const [layer, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    ids.sort();
    ids.forEach((id, rowIndex) => {
      const riskLevel = riskByNode.get(id) ?? "unknown";
      nodes.push({
        id,
        label: labelByNode.get(id) ?? id,
        riskLevel,
        incoming: incoming.get(id) ?? 0,
        outgoing: outgoing.get(id) ?? 0,
        depth: layer,
        x: layer * COLUMN_GAP,
        y: rowIndex * ROW_GAP,
        unknownRisk: riskLevel === "unknown",
      });
    });
  }

  const edges: DependencyGraphEdge[] = normalizedEdges
    .map((edge) => {
      const source = nodeIdFor(edge.fromService);
      const target = nodeIdFor(edge.toService);
      return {
        id: `${source}->${target}:${edge.type}`,
        source,
        target,
        type: edge.type,
        label: edgeLabelFor(edge.type),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const isolated = nodes.filter((node) => node.incoming === 0 && node.outgoing === 0).map((node) => node.id);

  const kinds = new Set(normalizedEdges.map((edge) => edge.type));

  return {
    nodes,
    edges,
    isolated,
    cycles: findCycles(nodeIds, adjacency),
    suppressedEdges: suppressed,
    edgeTypes: [...kinds].sort(),
  };
}

/** Risk levels present in the model, for a legend. Sorted into the documented order. */
export function riskLevelsPresent(model: DependencyGraphModel): GraphRiskLevel[] {
  const present = new Set(model.nodes.map((node) => node.riskLevel));
  const ordered: GraphRiskLevel[] = [...RISK_LEVELS, "unknown"];
  return ordered.filter((level) => present.has(level));
}

/** Canvas size that fits the laid-out nodes, with padding. */
export function canvasSizeFor(model: DependencyGraphModel): { width: number; height: number } {
  const maxX = model.nodes.reduce((max, node) => Math.max(max, node.x), 0);
  const maxY = model.nodes.reduce((max, node) => Math.max(max, node.y), 0);
  return {
    width: Math.max(maxX + NODE_WIDTH + 80, 320),
    height: Math.max(maxY + NODE_HEIGHT + 80, 200),
  };
}
