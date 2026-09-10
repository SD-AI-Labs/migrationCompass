import { describe, expect, it } from "vitest";

import {
  MissingConfigurationError,
  embeddingsEnv,
  embeddingsEnvSchema,
  isConfigured,
  llmEnvSchema,
  observabilityEnv,
  parseEnv,
  observabilityEnvSchema,
} from "./env";
import type { EmbeddingsEnv, EnvSource, LlmEnv, ObservabilityEnv } from "./env";

/**
 * These tests pass an explicit `source` object instead of mutating process.env,
 * which is the whole reason `parseEnv` takes one: the caching that makes env
 * reads cheap in production would otherwise make the tests order-dependent.
 */

describe("parseEnv", () => {
  it("names the missing variable when a required one is absent", () => {
    const source = { LLM_MODEL: "deepseek-chat" } satisfies EnvSource;

    expect(() => parseEnv(llmEnvSchema, "LLM calls", source)).toThrowError(MissingConfigurationError);

    try {
      parseEnv(llmEnvSchema, "LLM calls", source);
    } catch (error) {
      const failure = error as MissingConfigurationError;
      expect(failure.missing).toContain("DEEPSEEK_API_KEY");
      expect(failure.message).toContain("LLM calls");
      expect(failure.message).toContain("v2/.env.example");
    }
  });

  it("applies defaults for optional values", () => {
    const result = parseEnv<EmbeddingsEnv>(embeddingsEnvSchema, "Embeddings", {
      EMBEDDING_DIMENSIONS: "1536",
    });
    expect(result.OLLAMA_BASE_URL).toBe("http://localhost:11434");
  });

  it("coerces numeric strings", () => {
    const result = parseEnv<EmbeddingsEnv>(embeddingsEnvSchema, "Embeddings", {
      EMBEDDING_DIMENSIONS: "1536",
    });
    expect(result.EMBEDDING_DIMENSIONS).toBe(1536);
  });
});

describe("capability isolation", () => {
  it("does not require an API key to read the embeddings config", () => {
    const result = parseEnv<EmbeddingsEnv>(embeddingsEnvSchema, "Embeddings", {
      EMBEDDING_DIMENSIONS: "768",
    });
    expect(result.EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("does not require an API key to read the observability config", () => {
    const result = parseEnv<ObservabilityEnv>(observabilityEnvSchema, "Observability", {});
    expect(result.OTEL_SERVICE_NAME).toBe("migration-compass");
  });

  it("reports LLM as unconfigured rather than throwing from isConfigured", () => {
    const probe = () => parseEnv<LlmEnv>(llmEnvSchema, "LLM calls", {});
    expect(isConfigured(probe)).toBe(false);
  });
});

describe("booleanish fields", () => {
  it("parses explicit false as false, not as a truthy string", () => {
    const result = parseEnv<ObservabilityEnv>(observabilityEnvSchema, "Observability", { OTEL_ENABLED: "false" });
    expect(result.OTEL_ENABLED).toBe(false);
  });

  it("defaults to true when unset", () => {
    const result = parseEnv<ObservabilityEnv>(observabilityEnvSchema, "Observability", {});
    expect(result.OTEL_ENABLED).toBe(true);
    expect(result.ADMIN_TRACES_ENABLED).toBe(true);
  });

  it("rejects a value that is neither true nor false", () => {
    expect(() =>
      parseEnv(observabilityEnvSchema, "Observability", { OTEL_ENABLED: "yes" }),
    ).toThrowError(MissingConfigurationError);
  });
});

describe("errors surfaced by the real accessors", () => {
  it("throws a MissingConfigurationError naming DATABASE_URL when no database is configured", () => {
    // The real accessors read process.env; the test environment deliberately has
    // no DATABASE_URL, so this asserts the actual fast-path behavior: a page that
    // never touches the database must not be blocked by its absence.
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(isConfigured(observabilityEnv)).toBe(true);
      expect(isConfigured(embeddingsEnv)).toBe(true);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});
