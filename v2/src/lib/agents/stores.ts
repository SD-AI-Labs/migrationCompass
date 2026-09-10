import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { analysisRuns, findings, serviceDependencies } from "@/db/schema";

import type { AnalysisStore, StoredDependency, StoredFinding } from "./persistence";
import type { RunRecord, RunReports, RunStore, RunStep } from "./run";

/**
 * Drizzle implementations of the run and analysis-result stores.
 *
 * The two are separate ports because they have different lifetimes: the run store
 * is written to throughout a run (many small transitions) while the analysis store
 * is written once at the end (one large result). Merging them would mean a
 * database transaction spanning the whole run.
 */

export function createDrizzleRunStore(db: Database = getDb()): RunStore {
  return {
    async create({ projectId, ownerId }) {
      const [created] = await db
        .insert(analysisRuns)
        // Explicitly `pending`, not the column default: a row that exists but has
        // not started must not read as running.
        .values({ projectId, ownerId, status: "pending", step: "discovery" })
        .returning({ id: analysisRuns.id });

      if (!created) throw new Error("Run insert returned no row.");
      return created;
    },

    async markRunning(runId) {
      await db.update(analysisRuns).set({ status: "running" }).where(eq(analysisRuns.id, runId));
    },

    async advanceStep(runId, step: RunStep) {
      await db.update(analysisRuns).set({ step }).where(eq(analysisRuns.id, runId));
    },

    async complete(runId, reports: RunReports) {
      await db
        .update(analysisRuns)
        .set({
          status: "complete",
          step: "done",
          discoveryReport: reports.discoveryReport,
          architectureProposal: reports.architectureProposal,
          riskAssessment: reports.riskAssessment,
          comparisonReport: reports.comparisonReport,
          error: null,
          completedAt: new Date(),
        })
        .where(eq(analysisRuns.id, runId));
    },

    async fail(runId, { stage, message }) {
      await db
        .update(analysisRuns)
        .set({
          status: "failed",
          step: stage,
          // Truncated so a runaway stack-bearing message cannot make the row
          // unusable; the stage is stored separately, so the diagnostic survives.
          error: message.slice(0, 4000),
          completedAt: new Date(),
        })
        .where(eq(analysisRuns.id, runId));
    },

    async getRun(ownerId, runId) {
      const [row] = await db
        .select()
        .from(analysisRuns)
        .where(and(eq(analysisRuns.ownerId, ownerId), eq(analysisRuns.id, runId)))
        .limit(1);
      return row ? toRunRecord(row) : null;
    },

    async latestRun(ownerId, projectId) {
      const [row] = await db
        .select()
        .from(analysisRuns)
        .where(and(eq(analysisRuns.ownerId, ownerId), eq(analysisRuns.projectId, projectId)))
        .orderBy(desc(analysisRuns.createdAt))
        .limit(1);
      return row ? toRunRecord(row) : null;
    },
  };
}

type RunRow = typeof analysisRuns.$inferSelect;

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerId: row.ownerId,
    status: row.status,
    step: row.step,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export function createDrizzleAnalysisStore(db: Database = getDb()): AnalysisStore {
  return {
    async replaceResults({ runId, projectId, findings: findingRows, dependencies }) {
      // Scoped to this run id only. Another run's findings and edges are never
      // touched — re-analysing a project adds a comparable second graph rather
      // than overwriting the first, which is the M0 per-run decision.
      await db.transaction(async (tx) => {
        await tx.delete(findings).where(eq(findings.runId, runId));
        await tx.delete(serviceDependencies).where(eq(serviceDependencies.runId, runId));

        if (findingRows.length > 0) {
          await tx.insert(findings).values(findingRows.map((finding) => ({ ...finding, runId, projectId })));
        }
        if (dependencies.length > 0) {
          await tx
            .insert(serviceDependencies)
            .values(dependencies.map((dependency) => ({ ...dependency, runId, projectId })));
        }
      });
    },

    async findFindings(projectId, runId): Promise<StoredFinding[]> {
      const rows = await db
        .select()
        .from(findings)
        .where(and(eq(findings.projectId, projectId), eq(findings.runId, runId)));

      return rows.map((row) => ({
        id: row.id,
        serviceName: row.serviceName,
        riskLevel: row.riskLevel,
        riskFactors: row.riskFactors,
        recommendation: row.recommendation,
        hasTestCoverageGap: row.hasTestCoverageGap,
        dataQualityIssueCount: row.dataQualityIssueCount,
        requiresMajorRestructuring: row.requiresMajorRestructuring,
        dependentCount: row.dependentCount,
      }));
    },

    async findDependencies(projectId, runId): Promise<StoredDependency[]> {
      const rows = await db
        .select()
        .from(serviceDependencies)
        .where(and(eq(serviceDependencies.projectId, projectId), eq(serviceDependencies.runId, runId)));

      return rows.map((row) => ({
        id: row.id,
        fromService: row.fromService,
        toService: row.toService,
        type: row.type,
        evidence: row.evidence,
      }));
    },
  };
}

/**
 * Latest run per project, for the project page.
 *
 * Read as one query and reduced in memory rather than one query per project: the
 * page needs a handful of runs, and N+1 queries to render a list is the kind of
 * thing that is invisible until someone has fifty projects.
 */
export async function latestRunsForOwner(
  ownerId: string,
  projectIds: string[],
  db: Database = getDb(),
): Promise<Map<string, RunRecord>> {
  if (projectIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(analysisRuns)
    .where(and(eq(analysisRuns.ownerId, ownerId), inArray(analysisRuns.projectId, projectIds)))
    .orderBy(desc(analysisRuns.createdAt));

  const latest = new Map<string, RunRecord>();
  for (const row of rows) {
    if (!latest.has(row.projectId)) latest.set(row.projectId, toRunRecord(row));
  }
  return latest;
}
