import { edgeLabelFor, type DependencyGraphModel, type GraphRiskLevel } from "@/lib/graph/build-graph";

/**
 * The dependency graph, as text.
 *
 * React Flow is a canvas: nodes and edges are positioned SVG with no reading order a
 * screen reader can follow, and the same is true of a screenshot for anyone who cannot
 * see it. It is also, at the time of writing, unreliably rendered — the edge layer has a
 * known defect — so the visual graph is not something a reader should have to depend on
 * to learn the topology.
 *
 * This renders the *same* `DependencyGraphModel` the visual graph draws, with no second
 * derivation: if the two ever disagreed, the model would be the thing to fix, not this
 * view. It is plain semantic HTML — headings, lists and sentences — so it needs no
 * ARIA beyond accessible names on the lists, works without JavaScript, and is
 * selectable and copyable.
 *
 * Risk is always stated as a word (`critical`, `unrated`) as well as carried by the
 * palette, so nothing here is colour-only.
 *
 * Presentation: it is a section of the report surface, not a fallback panel. Two
 * columns on a wide screen (edges beside the inventory, which is how they are read
 * together), hairline-separated rows, and a heading with a real marker — the list is a
 * first-class way to read the topology, and it should not look like an error message.
 */

const RISK_WORDS: Record<GraphRiskLevel, string> = {
  critical: "critical risk",
  high: "high risk",
  medium: "medium risk",
  low: "low risk",
  unknown: "unrated",
};

function riskWord(level: GraphRiskLevel): string {
  return RISK_WORDS[level] ?? RISK_WORDS.unknown;
}

function SubHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h4 id={id} className="eyebrow">
      {children}
    </h4>
  );
}

export function DependencyList({ model }: { model: DependencyGraphModel }) {
  const labelById = new Map(model.nodes.map((node) => [node.id, node.label]));
  const riskById = new Map(model.nodes.map((node) => [node.id, node.riskLevel]));
  const labelFor = (id: string): string => labelById.get(id) ?? id;

  return (
    <details open className="row-disclosure">
      <summary className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
        <h3 className="text-[18px] font-semibold tracking-tight">Dependencies (text)</h3>
        <span aria-hidden className="marker col-start-2 row-span-2 self-center">
          ›
        </span>
        <p className="meta measure col-start-1">
          The same {model.nodes.length} service(s) and {model.edges.length} recorded edge(s) as the
          graph above, as text — for screen readers, for copying, and because a list cannot fail to
          render its edges.
        </p>
      </summary>

      <div className="grid grid-cols-1 gap-x-12 gap-y-6 pt-4 pb-6 lg:grid-cols-2">
        <section aria-labelledby="dependency-edges" className="min-w-0">
          <SubHeading id="dependency-edges">Recorded dependencies ({model.edges.length})</SubHeading>

          {model.edges.length === 0 ? (
            <p className="note mt-3">
              No dependency edges were recorded for this run, so no service is shown as depending on
              another. The inventory beside it is therefore a list of services with no recorded
              relationships.
            </p>
          ) : (
            <ul aria-label="Recorded dependencies" className="mt-2">
              {model.edges.map((edge) => (
                <li
                  key={edge.id}
                  className="border-b border-[var(--border-subtle)] py-1.5 text-[12px] leading-relaxed last:border-b-0"
                >
                  <span className="font-medium">
                    {labelFor(edge.source)} depends on {labelFor(edge.target)}
                  </span>{" "}
                  <span className="text-[var(--muted)]">
                    — {edgeLabelFor(edge.type)} ({riskWord(riskById.get(edge.source) ?? "unknown")}{" "}
                    source, {riskWord(riskById.get(edge.target) ?? "unknown")} target)
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="dependency-services" className="min-w-0">
          <SubHeading id="dependency-services">Services ({model.nodes.length})</SubHeading>

          {model.nodes.length === 0 ? (
            <p className="note mt-3">No services were recorded for this run.</p>
          ) : (
            <ul aria-label="Services in the dependency graph" className="mt-2">
              {model.nodes.map((node) => (
                <li
                  key={node.id}
                  className="border-b border-[var(--border-subtle)] py-1.5 text-[12px] leading-relaxed last:border-b-0"
                >
                  <span className="font-medium">{node.label}</span>{" "}
                  <span className="text-[var(--muted)]">
                    — {riskWord(node.riskLevel)}, {node.incoming} dependent(s), {node.outgoing}{" "}
                    outgoing dependenc{node.outgoing === 1 ? "y" : "ies"}
                    {node.incoming === 0 && node.outgoing === 0
                      ? " (no recorded relationships)"
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {model.cycles.length > 0 && (
          <section aria-labelledby="dependency-cycles" className="min-w-0 lg:col-span-2">
            <SubHeading id="dependency-cycles">
              Circular chains ({model.cycles.length})
            </SubHeading>
            <ul aria-label="Circular dependency chains" className="mt-2">
              {model.cycles.map((cycle) => (
                <li
                  key={cycle.join("->")}
                  className="border-b border-[var(--border-subtle)] py-1.5 text-[12px] leading-relaxed last:border-b-0"
                >
                  <span className="text-[var(--risk-medium)]">
                    {cycle.map(labelFor).join(" depends on ")}
                  </span>{" "}
                  <span className="text-[var(--muted)]">
                    — these services form a cycle, so they cannot be migrated independently in the
                    recorded order.
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {model.suppressedEdges > 0 && (
          <p className="meta lg:col-span-2">
            {model.suppressedEdges} duplicate or self-referencing edge(s) were suppressed before this
            list was built, so the counts above are what the analysis recorded minus that noise.
          </p>
        )}
      </div>
    </details>
  );
}
