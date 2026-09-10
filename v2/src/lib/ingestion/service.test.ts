import { strToU8, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createStubEmbeddings } from "@/lib/embeddings/embeddings";
import {
  DuplicateProjectError,
  EmptyProjectError,
  ingestArchive,
  planIngestion,
} from "./service";
import type { ProjectStore } from "./service";
import type { Chunk } from "./chunking";

/**
 * The store is faked rather than mocked: this suite is about ingestion's
 * decisions and ordering (what gets embedded, what gets persisted, what happens
 * when a write fails), and a fake records exactly that without a database.
 */

type StoredProject = {
  id: string;
  ownerId: string;
  name: string;
  sourceHash: string | null;
  sourceType: "example" | "upload";
  fileCount: number;
  chunkCount: number;
};

type StoredChunk = Chunk & { projectId: string; embedding: number[] };

function createFakeStore(options: { failChunkInsert?: boolean } = {}) {
  const projects: StoredProject[] = [];
  const chunks: StoredChunk[] = [];
  const calls: string[] = [];
  let sequence = 0;

  const store: ProjectStore = {
    async findDuplicate(ownerId, sourceHash) {
      calls.push("findDuplicate");
      return (
        projects.find((project) => project.ownerId === ownerId && project.sourceHash === sourceHash) ?? null
      );
    },
    async createProject(input) {
      calls.push("createProject");
      sequence += 1;
      const project: StoredProject = { id: `project-${sequence}`, ...input };
      projects.push(project);
      return { id: project.id };
    },
    async insertChunks(projectId, rows) {
      calls.push("insertChunks");
      if (options.failChunkInsert) throw new Error("chunk insert failed");
      for (const row of rows) {
        chunks.push({ ...row, projectId });
      }
    },
    async deleteProject(projectId) {
      calls.push("deleteProject");
      const index = projects.findIndex((project) => project.id === projectId);
      if (index >= 0) projects.splice(index, 1);
      for (let cursor = chunks.length - 1; cursor >= 0; cursor -= 1) {
        if (chunks[cursor]?.projectId === projectId) chunks.splice(cursor, 1);
      }
    },
  };

  return { store, projects, chunks, calls };
}

const archive = (entries: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])));

const SAMPLE = archive({
  "src/App.java": "class App { void run() {} }",
  "spec.yaml": "openapi: 3.0.0\ninfo:\n  title: Sample",
  "README.md": "# Sample system",
});

const embeddings = createStubEmbeddings(16);
const embed = (texts: string[]) => embeddings.embed(texts);

describe("planIngestion", () => {
  it("hashes the archive bytes", () => {
    const plan = planIngestion(SAMPLE, "sample.zip");
    expect(plan.sourceHash).toBe(createHash("sha256").update(SAMPLE).digest("hex"));
  });

  it("keeps ground truth out of the plan", () => {
    const plan = planIngestion(
      archive({
        "source-code/App.java": "class App {}",
        "ground-truth/architecture-overview.md": "# The answer the pipeline must not see",
      }),
      "example",
    );

    expect(plan.files.map((file) => file.path)).toEqual(["source-code/App.java"]);
    expect(plan.excludedGroundTruthCount).toBe(1);
  });

  it("carries extraction rejections through", () => {
    const plan = planIngestion(SAMPLE, "sample.zip");
    expect(plan.rejected).toEqual([]);
  });
});

describe("ingestArchive", () => {
  it("persists a project with its chunks and reports the counts", async () => {
    const fake = createFakeStore();
    const result = await ingestArchive({
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
    });

    expect(result.fileCount).toBe(3);
    expect(result.chunkCount).toBe(fake.chunks.length);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(fake.projects).toHaveLength(1);
    expect(fake.projects[0]?.ownerId).toBe("owner-1");
    expect(fake.projects[0]?.chunkCount).toBe(result.chunkCount);
  });

  it("attaches an embedding and a citation to every chunk", async () => {
    const fake = createFakeStore();
    await ingestArchive({
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
    });

    for (const chunk of fake.chunks) {
      expect(chunk.embedding).toHaveLength(16);
      expect(chunk.source.length).toBeGreaterThan(0);
      expect(chunk.projectId).toBe("project-1");
    }
    expect(fake.chunks.map((chunk) => chunk.source)).toContain("src/App.java");
  });

  it("refuses a byte-identical re-upload", async () => {
    const fake = createFakeStore();
    const request = {
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
    };

    await ingestArchive(request);
    await expect(ingestArchive(request)).rejects.toBeInstanceOf(DuplicateProjectError);
    expect(fake.projects).toHaveLength(1);
  });

  it("names the existing project in the duplicate error", async () => {
    const fake = createFakeStore();
    const request = {
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
    };

    await ingestArchive(request);
    await expect(ingestArchive(request)).rejects.toMatchObject({
      existingProjectId: "project-1",
      existingProjectName: "sample.zip",
    });
  });

  it("ingests the duplicate anyway when overridden", async () => {
    const fake = createFakeStore();
    const request = {
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
      override: true,
    };

    await ingestArchive(request);
    await ingestArchive(request);
    expect(fake.projects).toHaveLength(2);
  });

  it("scopes duplicate detection to the session", async () => {
    // Two visitors uploading the same public codebase is normal, not an error.
    const fake = createFakeStore();
    await ingestArchive({ ownerId: "owner-1", bytes: SAMPLE, projectName: "a.zip", embed, store: fake.store });
    await ingestArchive({ ownerId: "owner-2", bytes: SAMPLE, projectName: "b.zip", embed, store: fake.store });

    expect(fake.projects).toHaveLength(2);
    expect(fake.projects.map((project) => project.ownerId)).toEqual(["owner-1", "owner-2"]);
  });

  it("fails before spending on embeddings when nothing is indexable", async () => {
    const fake = createFakeStore();
    let embedCalled = false;

    await expect(
      ingestArchive({
        ownerId: "owner-1",
        bytes: archive({ "lib.so": "not text" }),
        projectName: "empty.zip",
        embed: async (texts) => {
          embedCalled = true;
          return embed(texts);
        },
        store: fake.store,
      }),
    ).rejects.toBeInstanceOf(EmptyProjectError);

    expect(embedCalled).toBe(false);
    expect(fake.calls).not.toContain("createProject");
  });

  it("checks for a duplicate before spending on embeddings", async () => {
    const fake = createFakeStore();
    await ingestArchive({ ownerId: "owner-1", bytes: SAMPLE, projectName: "a.zip", embed, store: fake.store });

    let embedCount = 0;
    await expect(
      ingestArchive({
        ownerId: "owner-1",
        bytes: SAMPLE,
        projectName: "a.zip",
        embed: async (texts) => {
          embedCount += 1;
          return embed(texts);
        },
        store: fake.store,
      }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);

    expect(embedCount).toBe(0);
  });

  it("does not create a project when the embedding provider under-delivers", async () => {
    const fake = createFakeStore();
    await expect(
      ingestArchive({
        ownerId: "owner-1",
        bytes: SAMPLE,
        projectName: "sample.zip",
        embed: async () => [[1, 2, 3]],
        store: fake.store,
      }),
    ).rejects.toThrow(/returned 1 vectors/);

    expect(fake.calls).not.toContain("createProject");
  });

  it("removes the project again when the chunk write fails", async () => {
    // A project with no chunks would render an analysis with nothing to retrieve
    // from — a worse outcome than a visible failure.
    const fake = createFakeStore({ failChunkInsert: true });

    await expect(
      ingestArchive({
        ownerId: "owner-1",
        bytes: SAMPLE,
        projectName: "sample.zip",
        embed,
        store: fake.store,
      }),
    ).rejects.toThrow("chunk insert failed");

    expect(fake.calls).toContain("deleteProject");
    expect(fake.projects).toHaveLength(0);
    expect(fake.chunks).toHaveLength(0);
  });

  it("reports an estimated token total", async () => {
    const fake = createFakeStore();
    const result = await ingestArchive({
      ownerId: "owner-1",
      bytes: SAMPLE,
      projectName: "sample.zip",
      embed,
      store: fake.store,
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});
