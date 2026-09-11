/**
 * Loads the checked-in sample fixture through the real ingestion pipeline.
 *
 *   pnpm seed:sample
 *   pnpm seed:sample --owner <sessionId>
 *   pnpm seed:sample --override        # re-ingest even if it already exists
 *
 * Why a script rather than a bespoke loader: the point of the fixture is to
 * exercise the pipeline, so it should go in through exactly the path an upload
 * takes — same extraction guards, same chunker, same duplicate detection, same
 * embeddings, same store. A fixture that used its own shortcut would be testing
 * the shortcut.
 *
 * Properties that matter:
 *
 * - **Idempotent.** The archive is packed reproducibly (sorted entries, fixed
 *   timestamps — see `lib/fixtures/archive.ts`), so its content hash is stable and
 *   the pipeline's own duplicate detection recognises a second run as the same
 *   upload. Without that, every run created another copy.
 * - **Session-preserving.** The project is written under an owner id like any other
 *   project; the script never bypasses owner scoping to make the fixture "just
 *   appear" for every visitor.
 * - **LLM-free.** Only Ollama embeddings are needed. No model call happens here;
 *   the analysis is started from the app, where the run is tracked.
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { closeDb, hasDatabaseConfig } from "@/db/client";
import { buildArchive, collectDirectoryFiles } from "@/lib/fixtures/archive";
import { createOllamaEmbeddings, embedInBatches } from "@/lib/embeddings/embeddings";
import { DuplicateProjectError, EmptyProjectError, ingestArchive } from "@/lib/ingestion/service";
import { createDrizzleProjectStore, listProjectsForOwner } from "@/lib/projects/repository";

const DEFAULT_OWNER_ID = "sample-fixture";

type Args = {
  ownerId: string;
  override: boolean;
  fixturePath: string;
};

function parseArgs(argv: string[]): Args {
  let ownerId = process.env.MC_OWNER_ID ?? DEFAULT_OWNER_ID;
  let override = false;
  let fixturePath =
    process.env.SAMPLE_FIXTURE_PATH ?? resolve(process.cwd(), "..", "fixtures", "sample-legacy-api");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--owner") {
      ownerId = argv[index + 1] ?? ownerId;
      index += 1;
    } else if (arg === "--override") {
      override = true;
    } else if (arg === "--fixture") {
      fixturePath = resolve(argv[index + 1] ?? fixturePath);
      index += 1;
    }
  }

  return { ownerId, override, fixturePath };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!hasDatabaseConfig()) {
    process.stderr.write(
      "No DATABASE_URL is configured. Start Postgres and set it before seeding:\n" +
        "  docker compose up -d postgres\n" +
        "  pnpm db:migrate\n",
    );
    return 1;
  }

  process.stdout.write(`Fixture:  ${args.fixturePath}\n`);
  process.stdout.write(`Owner:    ${args.ownerId}\n\n`);

  const files = await collectDirectoryFiles(args.fixturePath);
  const fileCount = Object.keys(files).length;
  if (fileCount === 0) {
    process.stderr.write("The fixture directory is empty — nothing to seed.\n");
    return 1;
  }

  const archive = buildArchive(files);
  const digest = createHash("sha256").update(archive).digest("hex").slice(0, 12);
  process.stdout.write(
    `Packed ${fileCount} file(s) into a ${(archive.length / 1024).toFixed(1)} KB archive ` +
      `(sha256 ${digest}...)\n`,
  );
  process.stdout.write("Embedding via Ollama (this is the slow part)...\n");

  const embeddings = createOllamaEmbeddings();

  try {
    const result = await ingestArchive({
      ownerId: args.ownerId,
      bytes: archive,
      projectName: "sample-legacy-api.zip",
      override: args.override,
      store: createDrizzleProjectStore(),
      embed: (texts) => embedInBatches(embeddings, texts),
    });

    process.stdout.write(
      `\nCreated  project ${result.projectId}\n` +
        `         ${result.fileCount} files indexed into ${result.chunkCount} chunks ` +
        `(~${result.estimatedTokens} tokens)\n`,
    );
    if (result.excludedGroundTruthCount > 0) {
      process.stdout.write(`         ${result.excludedGroundTruthCount} ground-truth file(s) excluded\n`);
    }
    if (result.rejected.length > 0) {
      process.stdout.write(`         ${result.rejected.length} archive entr(ies) rejected for safety\n`);
    }

    printHowToView(args.ownerId);
    return 0;
  } catch (error) {
    if (error instanceof DuplicateProjectError) {
      process.stdout.write(
        `\nReused   project ${error.existingProjectId} — this archive is already loaded as ` +
          `"${error.existingProjectName}".\n`,
      );
      if (error.existingProjectId) {
        const projects = await listProjectsForOwner(args.ownerId);
        const existing = projects.find((project) => project.id === error.existingProjectId);
        if (existing) {
          process.stdout.write(
            `         ${existing.fileCount} files, ${existing.chunkCount} chunks, created ` +
              `${existing.createdAt.toISOString()}\n`,
          );
        }
      }
      process.stdout.write("         Pass --override to ingest a second copy anyway.\n");
      printHowToView(args.ownerId);
      return 0;
    }

    if (error instanceof EmptyProjectError) {
      process.stderr.write(`\nNothing in the fixture was indexable: ${error.message}\n`);
      return 1;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nSeeding failed: ${message}\n`);
    if (/Ollama embeddings request failed|fetch failed|ECONNREFUSED/.test(message)) {
      process.stderr.write(
        "Ollama is required for embeddings. Start it and pull the model:\n" +
          "  docker compose up -d ollama\n" +
          "  docker compose exec ollama ollama pull nomic-embed-text\n",
      );
    }
    return 1;
  }
}

/**
 * The browser has its own anonymous session id, so a seeded project is only
 * visible to a session that shares the owner id. Printed rather than
 * special-cased in the app: making the fixture visible to everyone would mean
 * weakening the session isolation the project deliberately keeps.
 */
function printHowToView(ownerId: string): void {
  process.stdout.write(
    "\nTo view it in the app:\n" +
      `  1. pnpm dev\n` +
      `  2. in the browser console, set the session cookie to this owner:\n` +
      `       document.cookie = "mc_owner=${ownerId}; path=/"\n` +
      `  3. reload — the project appears with a "Run analysis" button\n`,
  );
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
