"use client";

import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState, type CSSProperties } from "react";

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  RISK_COLORS,
  canvasSizeFor,
  edgeLabelFor,
  riskLevelsPresent,
  type DependencyGraphModel,
} from "@/lib/graph/build-graph";
import type { ScoringFinding } from "@/lib/scoring/rubric";

/**
 * The dependency graph — Layer 2/3 of the continuous page.
 *
 * Draws the model built server-side from the persisted `service_dependencies`
 * rows. Nothing here discovers relationships: the edges drawn are exactly the
 * edges the analysis recorded, and a service reached only by an edge is drawn in
 * the "unrated" colour rather than being given a risk level it never had.
 *
 * Interaction follows the plan: pan/zoom and click-to-expand-inline. Nodes are
 * deliberately not draggable — the layout is deterministic (so the same run always
 * renders the same picture), and letting a reader rearrange it would make a
 * screenshot unreproducible without adding any information.
 */

/**
 * Edge colours, from the theme's tokens rather than from literals here: the same
 * rule the risk palette follows (see `RISK_COLORS`), so a palette change lands in
 * one place. Synchronous calls take the primary accent, asynchronous ones the
 * secondary, and shared-database coupling the warning colour — the one edge type
 * that is a migration hazard rather than a dependency.
 */
const EDGE_STYLE: Record<string, { stroke: string; dashed: boolean }> = {
  sync_call: { stroke: "var(--edge-sync)", dashed: false },
  async_event: { stroke: "var(--edge-async)", dashed: true },
  shared_db: { stroke: "var(--edge-shared-db)", dashed: true },
  external_api: { stroke: "var(--edge-external)", dashed: true },
  unknown: { stroke: "var(--edge-unknown)", dashed: true },
};

function nodeStyle(riskLevel: string): CSSProperties {
  const color = RISK_COLORS[riskLevel as keyof typeof RISK_COLORS] ?? RISK_COLORS.unknown;
  return {
    width: NODE_WIDTH,
    // Pinned rather than content-driven: the layout is computed from NODE_HEIGHT, so
    // if the rendered box grew past it (two lines of text plus padding did exactly
    // that) rows in the same column would overlap and the canvas would be sized
    // short of its contents.
    height: NODE_HEIGHT,
    padding: "8px 10px",
    borderRadius: 8,
    border: `2px solid ${color}`,
    background: "var(--surface-raised)",
    color: "var(--foreground)",
    fontSize: 12,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    boxSizing: "border-box",
  };
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function DependencyGraph({
  model,
  findings,
}: {
  model: DependencyGraphModel;
  findings: ScoringFinding[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes: Node[] = useMemo(
    () =>
      model.nodes.map((node) => ({
        id: node.id,
        position: { x: node.x, y: node.y },
        // The default node renders `data.label`, so the risk badge and the
        // dependent count travel with the node rather than in a side legend.
        data: {
          label: (
            <div>
              <div style={{ fontWeight: 600 }}>{node.label}</div>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>
                {node.riskLevel}
                {/* Edge-derived, not read from the finding: the badge describes the
                    graph in front of the reader, and the panel below reconciles it
                    with the persisted finding. */}
                {node.incoming > 0 ? ` · ${node.incoming} dependent(s)` : ""}
                {node.incoming === 0 && node.outgoing === 0 ? " · isolated" : ""}
              </div>
            </div>
          ),
        },
        style: nodeStyle(node.riskLevel),
        draggable: false,
      })),
    [model.nodes],
  );

  const edges: Edge[] = useMemo(
    () =>
      model.edges.map((edge) => {
        const style = EDGE_STYLE[edge.type] ?? EDGE_STYLE.unknown;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edgeLabelFor(edge.type),
          labelStyle: { fill: "var(--muted)", fontSize: 10 },
          animated: style?.dashed ?? false,
          style: { stroke: style?.stroke ?? EDGE_STYLE.unknown?.stroke, strokeDasharray: style?.dashed ? "4 4" : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color: style?.stroke ?? "var(--edge-unknown)" },
        };
      }),
    [model.edges],
  );

  const selectedNode = model.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedFinding = selectedNode
    ? findings.find((finding) => normalize(finding.serviceName) === normalize(selectedNode.id)) ?? null
    : null;

  const canvas = canvasSizeFor(model);
  const levels = riskLevelsPresent(model);

  return (
    <section
      aria-labelledby="dependency-graph-heading"
      className="mt-10 border-t border-[var(--border-subtle)] pt-8"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="dependency-graph-heading" className="text-[18px] font-semibold tracking-tight">
          Dependency graph
        </h3>
        <p className="meta">
          {model.nodes.length} services · {model.edges.length} typed edges
          {model.suppressedEdges > 0 ? ` · ${model.suppressedEdges} duplicate/self edge(s) suppressed` : ""}
        </p>
      </div>

      {model.edges.length === 0 ? (
        <p className="note measure mt-3">
          No dependency edges were recorded for this run, so only the service inventory is shown. Risk is
          equal-weighted as a result — see the scorecard&apos;s evidence notes. The inventory itself is
          listed as text below.
        </p>
      ) : (
        <p className="caption measure mt-1">
          Edges are the relationships the analysis actually found. Drag to pan, scroll to zoom, click a
          service to see its findings — or read the same topology as text below.
        </p>
      )}

      {model.cycles.length > 0 && (
        <p className="note measure mt-2 border-l-2 border-l-[var(--risk-medium)] border-solid text-[var(--risk-medium)]">
          {model.cycles.length} dependency cycle(s) detected — e.g. {model.cycles[0]?.join(" → ")}. A cycle
          means these services cannot be migrated independently in the recorded order.
        </p>
      )}

      <div className="well mt-3 overflow-hidden">
        <div style={{ width: "100%", height: Math.min(canvas.height, 460) }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
          >
            <Background color="var(--border)" gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <div className="meta mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {levels.map((level) => (
          <span key={level} className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block size-2 rounded-full"
              style={{ background: RISK_COLORS[level] }}
            />
            {level}
          </span>
        ))}
        {model.edgeTypes.map((type) => (
          <span key={type} className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4"
              style={{ background: (EDGE_STYLE[type] ?? EDGE_STYLE.unknown)?.stroke }}
            />
            {edgeLabelFor(type)}
          </span>
        ))}
      </div>

      {selectedNode && (
        <div className="tile mt-3 border border-[var(--border-subtle)] p-3.5">
          <p className="text-[13px] font-medium">{selectedNode.label}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-3 lg:grid-cols-6">
            <div>
              <dt className="text-[var(--muted)]">Risk level</dt>
              <dd>{selectedNode.riskLevel}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Depends on</dt>
              <dd className="tabular-nums">{selectedNode.outgoing}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Depended on by</dt>
              <dd className="tabular-nums">{selectedNode.incoming}</dd>
            </div>
            {selectedFinding && (
              <>
                <div>
                  <dt className="text-[var(--muted)]">Test-coverage gap</dt>
                  <dd>{selectedFinding.hasTestCoverageGap ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Data-quality issues</dt>
                  <dd className="tabular-nums">{selectedFinding.dataQualityIssueCount}</dd>
                </div>
                <div>
                  <dt className="text-[var(--muted)]">Major restructuring</dt>
                  <dd>{selectedFinding.requiresMajorRestructuring ? "required" : "not required"}</dd>
                </div>
              </>
            )}
          </dl>
          {!selectedFinding && (
            <p className="meta mt-2">
              This service appears only as an endpoint of a dependency edge — it was not in the analysed
              inventory, so it has no risk assessment.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
