import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  analysisRuns,
  chunks,
  findings,
  projects,
  scorecards,
  serviceDependencies,
  traceSpans,
} from "./schema";

/**
 * Schema invariants, not a field-list snapshot.
 *
 * These encode the plan's non-negotiables — owner scoping present from the
 * first migration, cascade deletes (deleting a project must not orphan rows),
 * and the rubric's typed inputs existing as columns rather than prose.
 */

const columnsOf = (table: PgTable): string[] =>
  getTableConfig(table).columns.map((column) => column.name);

const indexedColumns = (table: PgTable): string[] =>
  getTableConfig(table)
    .indexes.flatMap((index) =>
      index.config.columns.map((column) => ("name" in column ? String(column.name) : "")),
    )
    .filter((name) => name.length > 0);

const foreignTargets = (table: PgTable): { column: string; table: string; onDelete?: string }[] =>
  getTableConfig(table).foreignKeys.map((key) => {
    const reference = key.reference();
    return {
      column: reference.columns[0]?.name ?? "",
      table: getTableConfig(reference.foreignTable as PgTable).name,
      onDelete: key.onDelete,
    };
  });

describe("session-scoped ownership", () => {
  it("gives projects a required owner id", () => {
    const ownerId = getTableConfig(projects).columns.find((column) => column.name === "owner_id");
    expect(ownerId).toBeDefined();
    expect(ownerId?.notNull).toBe(true);
  });

  it("lets project lists be scoped by owner without a full table scan", () => {
    expect(indexedColumns(projects)).toContain("owner_id");
  });

  it("scopes analysis runs by owner as well as project", () => {
    const runColumns = columnsOf(analysisRuns);
    expect(runColumns).toContain("owner_id");
    expect(runColumns).toContain("project_id");
  });

  it("scopes scorecards by owner", () => {
    expect(columnsOf(scorecards)).toContain("owner_id");
  });
});

describe("project linkage and cleanup", () => {
  it.each([
    ["chunks", chunks],
    ["analysis_runs", analysisRuns],
    ["findings", findings],
    ["service_dependencies", serviceDependencies],
    ["scorecards", scorecards],
  ])("links %s to projects", (_label, table) => {
    expect(foreignTargets(table as PgTable)).toContainEqual(
      expect.objectContaining({ column: "project_id", table: "projects" }),
    );
  });

  it.each([
    ["chunks", chunks],
    ["analysis_runs", analysisRuns],
    ["findings", findings],
  ])("cascades deletes from projects into %s", (_label, table) => {
    const key = foreignTargets(table as PgTable).find((target) => target.table === "projects");
    expect(key?.onDelete).toBe("cascade");
  });
});

describe("rubric inputs are columns, not prose", () => {
  it("carries the per-service quality signals the scoring engine consumes", () => {
    const findingColumns = columnsOf(findings);
    expect(findingColumns).toContain("has_test_coverage_gap");
    expect(findingColumns).toContain("data_quality_issue_count");
    expect(findingColumns).toContain("requires_major_restructuring");
    expect(findingColumns).toContain("risk_level");
  });

  it("records how many services depend on each finding's service", () => {
    // Populated from service_dependencies; without it, risk weighting cannot
    // move off equal weighting.
    expect(columnsOf(findings)).toContain("dependent_count");
  });

  it("keeps the assumptions that produced each scorecard", () => {
    const scorecardColumns = columnsOf(scorecards);
    expect(scorecardColumns).toContain("assumptions");
    expect(scorecardColumns).toContain("breakdown");
    expect(scorecardColumns).toContain("risk_weighting");
  });

  it("distinguishes code-only estimates from refined ones", () => {
    expect(columnsOf(scorecards)).toContain("confidence");
  });
});

describe("dependency graph data source", () => {
  it("captures directed edges with a type", () => {
    const edgeColumns = columnsOf(serviceDependencies);
    expect(edgeColumns).toEqual(expect.arrayContaining(["from_service", "to_service", "type", "evidence"]));
  });

  it("indexes both ends so blast-radius queries stay cheap", () => {
    const indexed = indexedColumns(serviceDependencies);
    expect(indexed).toContain("from_service");
    expect(indexed).toContain("to_service");
  });
});

describe("vector storage", () => {
  it("sizes the embedding column to the configured dimensionality", () => {
    const embedding = getTableConfig(chunks).columns.find((column) => column.name === "embedding");
    expect(embedding).toBeDefined();
    expect((embedding as unknown as { dimensions?: number }).dimensions).toBe(EMBEDDING_DIMENSIONS);
  });
});

describe("tracing in the application database", () => {
  it("stores everything a waterfall needs", () => {
    const spanColumns = columnsOf(traceSpans);
    expect(spanColumns).toEqual(
      expect.arrayContaining([
        "trace_id",
        "span_id",
        "parent_span_id",
        "start_time",
        "end_time",
        "duration_ms",
        "status_code",
        "attributes",
      ]),
    );
  });

  it("indexes traces for lookup by id and by time", () => {
    expect(indexedColumns(traceSpans)).toContain("trace_id");
    expect(indexedColumns(traceSpans)).toContain("parent_span_id");
  });
});
