"use server";

import { revalidatePath } from "next/cache";

import { hasDatabaseConfig } from "@/db/client";
import { createOllamaEmbeddings, embedInBatches } from "@/lib/embeddings/embeddings";
import { DuplicateProjectError, EmptyProjectError, ingestArchive } from "@/lib/ingestion/service";
import { readOperationalFilesFromFormData } from "@/lib/operational/ingest";
import { saveRefinementForOwner } from "@/lib/operational/repository";
import { getLogger } from "@/lib/observability/logger";
import { withSpan } from "@/lib/observability/span";
import { createDrizzleProjectStore } from "@/lib/projects/repository";
import { parseOperationalFiles } from "@/lib/scoring/operational";
import { ensureOwnerId } from "@/lib/session";

import type { UploadState } from "./upload-state";

/**
 * Upload entry point.
 *
 * Server Action rather than a REST route: the browser is the only caller, so a
 * separate HTTP surface would be an API with exactly one consumer and a second
 * definition of every payload. See PROJECT_STATUS.md for why this deviates from
 * the plan's first-listed option (tRPC).
 *
 * Every failure mode the user can actually hit is mapped to a sentence they can
 * act on — duplicate upload, nothing indexable, Ollama down — rather than a
 * stack trace, because "it said error" is the least useful possible outcome.
 *
 * The state type and its initial value live in `./upload-state` — a `"use server"`
 * module may only export async functions.
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function uploadProjectAction(
  _previous: UploadState,
  formData: FormData,
): Promise<UploadState> {
  if (!hasDatabaseConfig()) {
    return {
      status: "error",
      message: "No database is configured, so there is nowhere to store the project.",
      detail: "Set DATABASE_URL (see v2/.env.example) and run `pnpm db:migrate`.",
    };
  }

  const file = formData.get("archive");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a .zip archive to upload." };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      status: "error",
      message: `That archive is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 100 MB.`,
    };
  }

  const override = formData.get("override") === "on";
  const ownerId = await ensureOwnerId();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Read (but do not yet store) the optional operational data. Parsing happens before
  // ingestion because a rejected archive must not leave operational data behind: the
  // rows need a project id, and there is no project to attach them to.
  const operationalFiles = await readOperationalFilesFromFormData(formData);
  const parsedOperational = parseOperationalFiles(operationalFiles.files);

  return withSpan(
    "ingestion.upload",
    { "upload.fileName": file.name, "upload.sizeBytes": file.size },
    async (span) => {
      try {
        const embeddings = createOllamaEmbeddings();
        const ingestionStartedAt = Date.now();

        // Ingestion is not part of an analysis run — it happens at upload, before a
        // run can be started — so it carries `stage: "ingestion"` rather than a run
        // id, and the name of the file rather than any of its contents.
        getLogger().info(
          { stage: "ingestion", fileName: file.name, sizeBytes: file.size },
          "Source ingestion started",
        );

        const result = await ingestArchive({
          ownerId,
          bytes,
          projectName: file.name,
          override,
          store: createDrizzleProjectStore(),
          embed: (texts) => embedInBatches(embeddings, texts),
        });

        span.setAttribute("project.id", result.projectId);
        span.setAttribute("project.chunkCount", result.chunkCount);

        // Now that the project exists, the operational data can be attached to it. The
        // project is created first and the data second, so a failure here leaves a
        // perfectly usable project with a code-only estimate rather than a half-written
        // one — and the message says so.
        let storedOperational = 0;
        let operationalError: string | null = null;

        if (parsedOperational.entries.length > 0) {
          try {
            const saved = await saveRefinementForOwner(ownerId, result.projectId, {
              entries: parsedOperational.entries,
            });
            storedOperational = saved?.addedEntries ?? 0;
          } catch (error) {
            getLogger().error({ error, projectId: result.projectId }, "Attaching operational data failed");
            operationalError =
              "The project was indexed, but the operational data could not be stored — it can be attached " +
              "from the scorecard instead.";
          }
        }

        getLogger().info(
          {
            stage: "ingestion",
            durationMs: Date.now() - ingestionStartedAt,
            projectId: result.projectId,
            files: result.fileCount,
            chunks: result.chunkCount,
            // Logged for visibility: a non-zero value here means ground truth was
            // in the archive and was (correctly) withheld from the pipeline.
            excludedGroundTruthCount: result.excludedGroundTruthCount,
            rejected: result.rejected.length,
            operationalFiles: storedOperational,
            operationalRejected: parsedOperational.errors.length + operationalFiles.skipped.length,
          },
          "Source ingestion completed",
        );

        revalidatePath("/");

        const notices: string[] = [];
        if (result.rejected.length > 0) {
          notices.push(`${result.rejected.length} archive entr(ies) rejected for safety`);
        }
        if (result.excludedGroundTruthCount > 0) {
          notices.push(`${result.excludedGroundTruthCount} ground-truth file(s) excluded from indexing`);
        }
        if (storedOperational > 0) {
          notices.push(`${storedOperational} operational data file(s) attached — refine the estimates any time`);
        }

        const operationalIssues = [
          ...operationalFiles.skipped,
          ...parsedOperational.errors.map((error) => error.error),
        ];
        if (operationalError !== null) operationalIssues.push(operationalError);

        return {
          status: "success",
          message: `Indexed ${result.fileCount} files into ${result.chunkCount} chunks.`,
          detail: notices.length > 0 ? notices.join(" · ") : undefined,
          operationalErrors: operationalIssues.length > 0 ? operationalIssues : undefined,
          projectId: result.projectId,
        };
      } catch (error) {
        return mapIngestionError(error);
      }
    },
  );
}

function mapIngestionError(error: unknown): UploadState {
  if (error instanceof DuplicateProjectError) {
    return {
      status: "error",
      message: "That exact archive has already been uploaded.",
      detail: "Choose the file again with 'Re-ingest duplicates' ticked to create a second project.",
    };
  }

  if (error instanceof EmptyProjectError) {
    return {
      status: "error",
      message: "Nothing in that archive was indexable.",
      detail: error.message,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  getLogger().error({ error, stage: "ingestion" }, "Source ingestion failed");

  if (/Ollama embeddings request failed|fetch failed|ECONNREFUSED/.test(message)) {
    return {
      status: "error",
      message: "Embeddings are unavailable, so the project could not be indexed.",
      detail: "Start Ollama and pull the model: `docker compose up -d ollama && docker compose exec ollama ollama pull nomic-embed-text`.",
    };
  }

  return {
    status: "error",
    message: "Ingestion failed before the project could be stored.",
    detail: message,
  };
}
