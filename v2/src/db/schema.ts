import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Schema notes that matter beyond the field list:
 *
 * - `projects.ownerId` is NOT optional and NOT added later. The plan commits to
 *   session-scoped isolation as a Phase 1 schema decision because concurrent
 *   visitors on a public URL must not see each other's codebases — that's a
 *   correctness bug, not missing polish.
 * - Findings carry the extra extraction fields the rubric needs
 *   (`hasTestCoverageGap`, `dataQualityIssueCount`, `requiresMajorRestructuring`)
 *   as typed columns rather than prose to be parsed. The plan calls this out as
 *   a prerequisite for the scoring engine.
 * - `serviceDependencies` is the dependency-graph data source. Risk weighting by
 *   dependent-count reads from here, so this table is the reason the rubric can
 *   move off equal weighting.
 * - Trace spans land in the same database as application data — the whole point
 *   of dropping the separate Zipkin container.
 */

/** Must match EMBEDDING_DIMENSIONS and the embeddings model in use. */
export const EMBEDDING_DIMENSIONS = 768;

export const sourceTypeEnum = pgEnum("source_type", ["example", "upload"]);
export const runStatusEnum = pgEnum("run_status", ["pending", "running", "complete", "failed"]);
export const runStepEnum = pgEnum("run_step", [
  "discovery",
  "architecture",
  "risk",
  "comparison",
  "done",
]);
export const riskLevelEnum = pgEnum("risk_level", ["critical", "high", "medium", "low"]);
export const dependencyTypeEnum = pgEnum("dependency_type", [
  "sync_call",
  "async_event",
  "shared_db",
  "external_api",
  "unknown",
]);
export const operationalDataKindEnum = pgEnum("operational_data_kind", [
  "log",
  "health",
  "traffic",
  "incident",
  "db_stats",
]);
export const confidenceEnum = pgEnum("score_confidence", ["code_only", "refined"]);
export const riskWeightingEnum = pgEnum("risk_weighting", ["equal", "dependency"]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Session-scoped owner. Every read path must filter on this. */
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    sourceType: sourceTypeEnum("source_type").notNull(),
    /** sha256 of the uploaded archive — the duplicate-detection key. Null for the bundled example. */
    sourceHash: text("source_hash"),
    fileCount: integer("file_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("projects_owner_created_idx").on(table.ownerId, table.createdAt),
    index("projects_source_hash_idx").on(table.sourceHash),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Path relative to the uploaded archive root — the citation shown to users. */
    source: text("source").notNull(),
    fileName: text("file_name").notNull(),
    /** Distinguishes code from logs/specs so retrieval can be scoped. */
    documentType: text("document_type").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    tokenCount: integer("token_count").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chunks_project_idx").on(table.projectId),
    index("chunks_project_source_idx").on(table.projectId, table.source),
  ],
);

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    status: runStatusEnum("status").notNull().default("running"),
    /** Persisted at each transition so progress is pollable from the DB, not from memory. */
    step: runStepEnum("step").notNull().default("discovery"),
    discoveryReport: text("discovery_report"),
    architectureProposal: text("architecture_proposal"),
    riskAssessment: text("risk_assessment"),
    comparisonReport: text("comparison_report"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("analysis_runs_project_idx").on(table.projectId),
    index("analysis_runs_owner_created_idx").on(table.ownerId, table.createdAt),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceName: text("service_name").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull(),
    riskFactors: jsonb("risk_factors").$type<string[]>().notNull().default([]),
    recommendation: text("recommendation"),
    /** Rubric input — typed, not sniffed out of riskFactors text. */
    hasTestCoverageGap: boolean("has_test_coverage_gap").notNull().default(false),
    dataQualityIssueCount: integer("data_quality_issue_count").notNull().default(0),
    requiresMajorRestructuring: boolean("requires_major_restructuring").notNull().default(false),
    /** How many other services depend on this one. Populated from serviceDependencies. */
    dependentCount: integer("dependent_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("findings_run_idx").on(table.runId),
    index("findings_project_service_idx").on(table.projectId, table.serviceName),
  ],
);

/** The dependency-graph data source: which service calls/imports which. */
export const serviceDependencies = pgTable(
  "service_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    fromService: text("from_service").notNull(),
    toService: text("to_service").notNull(),
    type: dependencyTypeEnum("type").notNull().default("unknown"),
    /** Static-analysis evidence, so an edge is never an unfalsifiable claim. */
    evidence: text("evidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("service_dependencies_project_idx").on(table.projectId),
    index("service_dependencies_from_idx").on(table.projectId, table.fromService),
    index("service_dependencies_to_idx").on(table.projectId, table.toService),
  ],
);

export const scorecards = pgTable(
  "scorecards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
    ownerId: text("owner_id").notNull(),
    /** The five headline numbers. All computed by src/lib/scoring — never by a model. */
    migrationReadiness: numeric("migration_readiness", { precision: 5, scale: 2 }).notNull(),
    risk: numeric("risk", { precision: 5, scale: 2 }).notNull(),
    effort: numeric("effort", { precision: 4, scale: 2 }).notNull(),
    cost: numeric("cost", { precision: 14, scale: 2 }).notNull(),
    timeWeeksMin: numeric("time_weeks_min", { precision: 6, scale: 2 }).notNull(),
    timeWeeksMax: numeric("time_weeks_max", { precision: 6, scale: 2 }).notNull(),
    confidence: confidenceEnum("confidence").notNull().default("code_only"),
    riskWeighting: riskWeightingEnum("risk_weighting").notNull().default("equal"),
    /** Per-score contribution breakdown — the answer to "why is this 62?". */
    breakdown: jsonb("breakdown").$type<Record<string, unknown>>().notNull(),
    /** The assumptions in force when this was computed, so it stays reproducible. */
    assumptions: jsonb("assumptions").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scorecards_project_idx").on(table.projectId),
    index("scorecards_owner_created_idx").on(table.ownerId, table.createdAt),
  ],
);

export const operationalData = pgTable(
  "operational_data",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: operationalDataKindEnum("kind").notNull(),
    source: text("source").notNull(),
    /** Raw text for logs/incidents; parsed payload for health/traffic/db stats. */
    content: text("content"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("operational_data_project_idx").on(table.projectId, table.kind)],
);

/** Migration parameters: business assumptions, not files. Parameterizes cost/time math. */
export const migrationParameters = pgTable("migration_parameters", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  targetEnvironment: text("target_environment"),
  provider: text("provider"),
  teamSize: integer("team_size"),
  weeklyRate: numeric("weekly_rate", { precision: 10, scale: 2 }),
  budget: numeric("budget", { precision: 14, scale: 2 }),
  timelineWeeks: integer("timeline_weeks"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** OTel spans, in the app's own database. /admin/traces renders these. */
export const traceSpans = pgTable(
  "trace_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    durationMs: numeric("duration_ms", { precision: 12, scale: 3 }).notNull(),
    statusCode: text("status_code").notNull().default("unset"),
    statusMessage: text("status_message"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    projectId: uuid("project_id"),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("trace_spans_trace_idx").on(table.traceId, table.startTime),
    index("trace_spans_parent_idx").on(table.traceId, table.parentSpanId),
    index("trace_spans_created_idx").on(table.createdAt),
  ],
);
