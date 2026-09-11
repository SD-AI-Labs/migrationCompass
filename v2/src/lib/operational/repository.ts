import { eq } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { migrationParameters, operationalData } from "@/db/schema";
import { getProjectForOwner } from "@/lib/projects/repository";
import { TARGET_ENVIRONMENTS, type OperationalKind } from "@/lib/scoring/assumptions";
import { serviceNameFromPayload, type OperationalEntry } from "@/lib/scoring/operational";
import { EMPTY_PARAMETERS, type MigrationParametersInput } from "@/lib/scoring/parameters";

/**
 * Persistence for the two M5 inputs: operational data and migration parameters.
 *
 * ## Ownership
 *
 * Every function that a user path can reach takes an `ownerId` and resolves the
 * project through the owner-scoped `getProjectForOwner` before touching anything.
 * A project outside the session resolves to `null`, which the caller renders as
 * "not found" — the same isolation the rest of the app keeps, with no auth layer
 * bolted on.
 *
 * ## Append vs replace, and why they differ
 *
 * Operational data **accumulates**: each file is a separate piece of evidence, and a
 * second upload of last month's health export must not delete last week's. Migration
 * parameters **replace**: there is exactly one set of business assumptions in force
 * for a project, enforced by a unique index, so a re-submitted form is an update
 * rather than a second opinion.
 *
 * Stored rows are returned in their validated shape (`OperationalEntry`,
 * `MigrationParametersInput`) so nothing downstream reads a database row directly.
 */

export type OperationalStore = {
  listEntries(projectId: string): Promise<OperationalEntry[]>;
  appendEntries(projectId: string, entries: OperationalEntry[]): Promise<number>;
  clearEntries(projectId: string): Promise<number>;
  readParameters(projectId: string): Promise<MigrationParametersInput>;
  writeParameters(projectId: string, parameters: MigrationParametersInput): Promise<void>;
};

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createDrizzleOperationalStore(db: Database = getDb()): OperationalStore {
  return {
    async listEntries(projectId) {
      const rows = await db
        .select()
        .from(operationalData)
        .where(eq(operationalData.projectId, projectId));

      return rows.map((row) => ({
        kind: row.kind,
        source: row.source,
        serviceName: serviceNameFromPayload(row.payload),
        content: row.content,
        payload: row.payload,
      }));
    },

    async appendEntries(projectId, entries) {
      if (entries.length === 0) return 0;

      await db.insert(operationalData).values(
        entries.map((entry) => ({
          projectId,
          kind: entry.kind as OperationalKind,
          source: entry.source,
          content: entry.content,
          payload: entry.payload,
        })),
      );

      return entries.length;
    },

    async clearEntries(projectId) {
      const removed = await db
        .delete(operationalData)
        .where(eq(operationalData.projectId, projectId))
        .returning({ id: operationalData.id });
      return removed.length;
    },

    async readParameters(projectId) {
      const [row] = await db
        .select()
        .from(migrationParameters)
        .where(eq(migrationParameters.projectId, projectId))
        .limit(1);

      if (!row) return EMPTY_PARAMETERS;

      const environment = TARGET_ENVIRONMENTS.find((candidate) => candidate === row.targetEnvironment);

      return {
        targetEnvironment: environment ?? null,
        provider: row.provider,
        teamSize: row.teamSize,
        weeklyRate: toNumber(row.weeklyRate),
        budget: toNumber(row.budget),
        timelineWeeks: row.timelineWeeks,
      };
    },

    async writeParameters(projectId, parameters) {
      const values = {
        projectId,
        targetEnvironment: parameters.targetEnvironment,
        provider: parameters.provider,
        teamSize: parameters.teamSize,
        // `numeric` columns round-trip as strings; written as strings for the same
        // reason, so no float formatting happens on the way in.
        weeklyRate: parameters.weeklyRate === null ? null : String(parameters.weeklyRate),
        budget: parameters.budget === null ? null : String(parameters.budget),
        timelineWeeks: parameters.timelineWeeks,
        updatedAt: new Date(),
      };

      await db
        .insert(migrationParameters)
        .values(values)
        .onConflictDoUpdate({ target: migrationParameters.projectId, set: values });
    },
  };
}

export type RefinementInputs = {
  entries: OperationalEntry[];
  parameters: MigrationParametersInput;
};

/** Reads a project's operational data and parameters, or null when this session does not own it. */
export async function loadRefinementInputsForOwner(
  ownerId: string,
  projectId: string,
  store: OperationalStore = createDrizzleOperationalStore(),
): Promise<RefinementInputs | null> {
  const project = await getProjectForOwner(ownerId, projectId);
  if (!project) return null;

  return {
    entries: await store.listEntries(projectId),
    parameters: await store.readParameters(projectId),
  };
}

export type SavedRefinement = {
  addedEntries: number;
  parametersSaved: boolean;
};

/**
 * Appends operational data and/or replaces the migration parameters for a project
 * this session owns. Null means "not this session's project", never a silent no-op.
 */
export async function saveRefinementForOwner(
  ownerId: string,
  projectId: string,
  input: {
    entries?: OperationalEntry[];
    parameters?: MigrationParametersInput;
    /** When true the submitted parameters replace the stored ones even if empty. */
    writeParameters?: boolean;
  },
  store: OperationalStore = createDrizzleOperationalStore(),
): Promise<SavedRefinement | null> {
  const project = await getProjectForOwner(ownerId, projectId);
  if (!project) return null;

  const addedEntries = input.entries ? await store.appendEntries(projectId, input.entries) : 0;
  const parametersSaved = input.parameters !== undefined && input.writeParameters !== false;

  if (parametersSaved && input.parameters) {
    await store.writeParameters(projectId, input.parameters);
  }

  return { addedEntries, parametersSaved };
}

/** Removes every operational data row for a project this session owns. */
export async function clearOperationalDataForOwner(
  ownerId: string,
  projectId: string,
  store: OperationalStore = createDrizzleOperationalStore(),
): Promise<number | null> {
  const project = await getProjectForOwner(ownerId, projectId);
  if (!project) return null;

  return store.clearEntries(projectId);
}
