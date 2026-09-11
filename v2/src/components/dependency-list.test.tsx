// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { buildDependencyGraph, type DependencyGraphModel } from "@/lib/graph/build-graph";

import { DependencyList } from "./dependency-list";

/**
 * The graph's text alternative.
 *
 * The visual graph is a canvas: React Flow positions nodes and edges as SVG with no
 * reading order, and its edge layer additionally has a known rendering defect. Both
 * mean the topology must be readable without it, so these tests assert that the same
 * model is expressed as sentences, under real headings, in lists with accessible
 * names — with severity in words rather than colour.
 */

afterEach(cleanup);

const FINDINGS = [
  { serviceName: "OrderService", riskLevel: "critical" as const, dependentCount: 2 },
  { serviceName: "InventoryService", riskLevel: "low" as const, dependentCount: 1 },
  { serviceName: "ReportingService", riskLevel: "medium" as const, dependentCount: 0 },
];

const model = (dependencies: { fromService: string; toService: string; type: string }[] = []): DependencyGraphModel =>
  buildDependencyGraph({ services: FINDINGS, dependencies });

const renderList = (graph: DependencyGraphModel) => render(<DependencyList model={graph} />);

describe("dependency text alternative", () => {
  it("is a disclosure with a real heading, open by default", () => {
    renderList(model([{ fromService: "OrderService", toService: "InventoryService", type: "sync_call" }]));

    const heading = screen.getByRole("heading", { level: 3, name: "Dependencies (text)" });
    const details = heading.closest("details") as HTMLDetailsElement;

    expect(details.open).toBe(true);
    expect(details.querySelector("summary")).toBeTruthy();
  });

  it("states each dependency as a sentence with its type and both services' risk", () => {
    renderList(
      model([
        { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
        { fromService: "ReportingService", toService: "LegacyExt", type: "unknown" },
      ]),
    );

    const edges = screen.getByRole("list", { name: "Recorded dependencies" });
    const rows = Array.from(edges.children).map((row) => row.textContent ?? "");

    expect(rows[0]).toContain("OrderService depends on InventoryService");
    expect(rows[0]).toContain("synchronous call");
    expect(rows[0]).toContain("critical risk source");
    expect(rows[0]).toContain("low risk target");
    // A service reached only through an edge is unrated, which is stated as a word.
    expect(rows[1]).toContain("unrated");
  });

  it("lists every service with its risk, dependents and outgoing dependencies", () => {
    renderList(model([{ fromService: "OrderService", toService: "InventoryService", type: "sync_call" }]));

    const services = Array.from(
      screen.getByRole("list", { name: "Services in the dependency graph" }).children,
    ).map((row) => row.textContent ?? "");

    expect(services).toHaveLength(3);

    const rowFor = (name: string): string =>
      services.find((row) => row.startsWith(name)) ?? "";

    expect(rowFor("InventoryService")).toContain("low risk");
    expect(rowFor("InventoryService")).toContain("1 dependent(s), 0 outgoing dependencies");
    expect(rowFor("OrderService")).toContain("critical risk");
    expect(rowFor("OrderService")).toContain("0 dependent(s), 1 outgoing dependency");
    // No edges at all for this one, and the list says so rather than showing zeros.
    expect(rowFor("ReportingService")).toContain("no recorded relationships");
  });

  it("names circular chains in dependency order", () => {
    renderList(
      model([
        { fromService: "OrderService", toService: "InventoryService", type: "shared_db" },
        { fromService: "InventoryService", toService: "OrderService", type: "shared_db" },
      ]),
    );

    const cycles = screen.getByRole("list", { name: "Circular dependency chains" });

    expect(cycles.textContent).toContain("depends on");
    expect(cycles.textContent).toContain("cannot be migrated independently");
  });

  it("says no edges were recorded rather than rendering an empty list", () => {
    renderList(model());

    expect(screen.queryByRole("list", { name: "Recorded dependencies" })).toBeNull();
    expect(screen.getByText(/No dependency edges were recorded/)).toBeTruthy();
    // The inventory is still shown: services exist even when their relationships do not.
    expect(screen.getByRole("list", { name: "Services in the dependency graph" })).toBeTruthy();
  });

  it("handles an empty model without claiming anything", () => {
    renderList(buildDependencyGraph({ services: [], dependencies: [] }));

    expect(screen.getByText(/No services were recorded for this run/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Services in the dependency graph" })).toBeNull();
  });

  it("reports suppressed duplicate and self edges, so the counts reconcile", () => {
    renderList(
      model([
        { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
        { fromService: "OrderService", toService: "InventoryService", type: "sync_call" },
        { fromService: "OrderService", toService: "OrderService", type: "sync_call" },
      ]),
    );

    expect(screen.getByText(/2 duplicate or self-referencing edge\(s\) were suppressed/)).toBeTruthy();
  });

  it("gives each part of the list its own heading, as a section rather than a fallback", () => {
    renderList(model([{ fromService: "OrderService", toService: "InventoryService", type: "sync_call" }]));

    expect(screen.getByRole("heading", { level: 4, name: /Recorded dependencies/ })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 4, name: /Services/ })).toBeTruthy();
    // The heading is the summary's own content, so the collapsed row reads as a
    // section title and not as a button.
    const heading = screen.getByRole("heading", { level: 3, name: "Dependencies (text)" });
    expect(heading.parentElement?.tagName).toBe("SUMMARY");
  });

  it("conveys severity as words, never as colour alone", () => {
    renderList(model([{ fromService: "OrderService", toService: "InventoryService", type: "sync_call" }]));

    const text = screen.getByRole("list", { name: "Services in the dependency graph" }).textContent ?? "";

    expect(text).toContain("critical risk");
    expect(text).toContain("low risk");
    expect(text).toContain("medium risk");
  });
});
