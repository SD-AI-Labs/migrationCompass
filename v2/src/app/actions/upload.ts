"use server";

import { revalidatePath } from "next/cache";

import { hasDatabaseConfig } from "@/db/client";
import { createOllamaEmbeddings, embedInBatches } from "@/lib/embeddings/embeddings";
import { DuplicateProjectError, EmptyProjectError, ingestArchive } from "@/lib/ingestion/service";
import { getLogger } from "@/lib/observability/logger";
import { withSpan } from "@/lib/observability/span";
import { createDrizzleProjectStore } from "@/lib/projects/repository";
import { ensureOwnerId } from "@/lib/session";

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
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type UploadState = {
  status: "idle" | "success" | "error";
  message: string;
  detail?: string;
  projectId?: string;
};

export const initialUploadState: UploadState = { status: "idle", message: "" };

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

  return withSpan(
    "ingestion.upload",
    { "upload.fileName": file.name, "upload.sizeBytes": file.size },
    async (span) => {
      try {
        const embeddings = createOllamaEmbeddings();
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

        getLogger().info(
          {
            projectId: result.projectId,
            files: result.fileCount,
            chunks: result.chunkCount,
            // Logged for visibility: a non-zero value here means ground truth was
            // in the archive and was (correctly) withheld from the pipeline.
            excludedGroundTruthCount: result.excludedGroundTruthCount,
            rejected: result.rejected.length,
          },
          "Project ingested",
        );

        revalidatePath("/");

        const notices: string[] = [];
        if (result.rejected.length > 0) {
          notices.push(`${result.rejected.length} archive entr(ies) rejected for safety`);
        }
        if (result.excludedGroundTruthCount > 0) {
          notices.push(`${result.excludedGroundTruthCount} ground-truth file(s) excluded from indexing`);
        }

        return {
          status: "success",
          message: `Indexed ${result.fileCount} files into ${result.chunkCount} chunks.`,
          detail: notices.length > 0 ? notices.join(" · ") : undefined,
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
  getLogger().error({ error }, "Project ingestion failed");

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
