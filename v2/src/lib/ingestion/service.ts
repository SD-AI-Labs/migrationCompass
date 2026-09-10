import type { Chunk, SourceFile } from "./chunking";
import { chunkFiles } from "./chunking";
import { DEFAULT_LIMITS, extractArchive } from "./extract";
import type { ExtractionLimits, Rejection } from "./extract";
import { sha256Hex } from "./hash";
import type { ScanOptions, SkippedFile } from "./scan";
import { scanFiles } from "./scan";

/**
 * The ingestion pipeline, split into a pure plan and an injected persistence
 * step. The split is what makes this testable without a database: the decision
 * logic (what to extract, what to index, how to chunk) is a function of the
 * archive bytes alone, and only the write needs a store.
 */

export type IngestPlan = {
  projectName: string;
  sourceHash: string;
  files: SourceFile[];
  chunks: Chunk[];
  rejected: Rejection[];
  skipped: SkippedFile[];
  excludedGroundTruthCount: number;
  totalBytes: number;
};

export type PlanOptions = {
  limits?: ExtractionLimits;
  scan?: ScanOptions;
};

/**
 * Pure: archive bytes in, everything decided about them out. No I/O, no model
 * calls — embedding happens later, because it is the one step that costs money
 * and time and therefore the one worth keeping separable.
 */
export function planIngestion(bytes: Uint8Array, projectName: string, options: PlanOptions = {}): IngestPlan {
  const extraction = extractArchive(bytes, options.limits ?? DEFAULT_LIMITS);
  const scan = scanFiles(extraction.files, options.scan);

  return {
    projectName,
    sourceHash: sha256Hex(bytes),
    files: scan.sources,
    chunks: chunkFiles(scan.sources),
    rejected: extraction.rejected,
    skipped: scan.skipped,
    excludedGroundTruthCount: scan.excludedGroundTruthCount,
    totalBytes: extraction.totalBytes,
  };
}

export class DuplicateProjectError extends Error {
  constructor(
    readonly existingProjectId: string,
    readonly existingProjectName: string,
  ) {
    super(
      `This archive is byte-for-byte identical to the already-uploaded project ` +
        `"${existingProjectName}" (${existingProjectId}). Re-upload with override to ingest it again.`,
    );
    this.name = "DuplicateProjectError";
  }
}

export class EmptyProjectError extends Error {
  constructor(skippedCount: number) {
    super(
      `No indexable files were found in this archive (${skippedCount} file(s) skipped: ` +
        `unsupported extensions, binaries, or excluded directories).`,
    );
    this.name = "EmptyProjectError";
  }
}

/** Persistence port. Implemented by the Drizzle store; faked in tests. */
export type ProjectStore = {
  findDuplicate(ownerId: string, sourceHash: string): Promise<{ id: string; name: string } | null>;
  createProject(input: {
    ownerId: string;
    name: string;
    sourceHash: string;
    sourceType: "example" | "upload";
    fileCount: number;
    chunkCount: number;
  }): Promise<{ id: string }>;
  insertChunks(projectId: string, chunks: Array<Chunk & { embedding: number[] }>): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
};

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

export type IngestInput = {
  ownerId: string;
  bytes: Uint8Array;
  projectName: string;
  sourceType?: "example" | "upload";
  /** Skip the duplicate check and ingest regardless. */
  override?: boolean;
  embed: EmbeddingFn;
  store: ProjectStore;
  planOptions?: PlanOptions;
};

export type IngestResult = {
  projectId: string;
  fileCount: number;
  chunkCount: number;
  rejected: Rejection[];
  skipped: SkippedFile[];
  excludedGroundTruthCount: number;
  estimatedTokens: number;
};

/**
 * Runs the full ingestion: plan → duplicate check → embed → persist.
 *
 * Ordering matters. The duplicate check runs before embedding so a repeated
 * upload costs nothing, and embedding runs before the project row is created so
 * a failure mid-embedding leaves no half-populated project behind. On failure
 * after creation, the project is deleted again rather than left as an empty
 * shell in the user's list.
 */
export async function ingestArchive(input: IngestInput): Promise<IngestResult> {
  const plan = planIngestion(input.bytes, input.projectName, input.planOptions);

  if (plan.files.length === 0) {
    throw new EmptyProjectError(plan.skipped.length);
  }

  if (!input.override) {
    const duplicate = await input.store.findDuplicate(input.ownerId, plan.sourceHash);
    if (duplicate) throw new DuplicateProjectError(duplicate.id, duplicate.name);
  }

  const vectors = await input.embed(plan.chunks.map((chunk) => chunk.content));
  if (vectors.length !== plan.chunks.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${plan.chunks.length} chunks.`,
    );
  }

  const project = await input.store.createProject({
    ownerId: input.ownerId,
    name: plan.projectName,
    sourceHash: plan.sourceHash,
    sourceType: input.sourceType ?? "upload",
    fileCount: plan.files.length,
    chunkCount: plan.chunks.length,
  });

  try {
    await input.store.insertChunks(
      project.id,
      plan.chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] ?? [] })),
    );
  } catch (error) {
    // No orphaned project rows: a chunk write that fails means the analysis has
    // nothing to retrieve from, so the project must not appear in the list.
    await input.store.deleteProject(project.id).catch(() => undefined);
    throw error;
  }

  return {
    projectId: project.id,
    fileCount: plan.files.length,
    chunkCount: plan.chunks.length,
    rejected: plan.rejected,
    skipped: plan.skipped,
    excludedGroundTruthCount: plan.excludedGroundTruthCount,
    estimatedTokens: plan.chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
  };
}
