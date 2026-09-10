import { z } from "zod";

/**
 * Environment is split per capability rather than validated as one blob.
 *
 * Why: the scorecard's fast path (rubric math over structured findings, the
 * schedule page, the empty state) must run with nothing configured at all —
 * no DB, no API key, no Ollama. If config were validated globally, a missing
 * DEEPSEEK_API_KEY would take down a page that never calls a model. Each
 * capability asks for exactly what it needs, and fails with a message naming
 * the variable and the file that documents it.
 */

const booleanish = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === "true"));

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

export const llmEnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1).default("deepseek-chat"),
  LLM_BASE_URL: z.string().min(1).default("https://api.deepseek.com/v1"),
});

export const embeddingsEnvSchema = z.object({
  OLLAMA_BASE_URL: z.string().min(1).default("http://localhost:11434"),
  EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),
});

export const observabilityEnvSchema = z.object({
  OTEL_SERVICE_NAME: z.string().min(1).default("migration-compass"),
  OTEL_ENABLED: booleanish(true),
  ADMIN_TRACES_ENABLED: booleanish(true),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type LlmEnv = z.infer<typeof llmEnvSchema>;
export type EmbeddingsEnv = z.infer<typeof embeddingsEnvSchema>;
export type ObservabilityEnv = z.infer<typeof observabilityEnvSchema>;

/** Thrown when a capability is used without the configuration it requires. */
export class MissingConfigurationError extends Error {
  constructor(
    readonly capability: string,
    readonly missing: string[],
  ) {
    super(
      `${capability} needs these environment variables, which are not set: ${missing.join(", ")}. ` +
        `See v2/.env.example for the full list.`,
    );
    this.name = "MissingConfigurationError";
  }
}

type AnySchema = z.ZodType<unknown>;

/**
 * A plain record rather than NodeJS.ProcessEnv: tests pass literal objects, and
 * ProcessEnv's required NODE_ENV makes every literal a type error for no benefit.
 */
export type EnvSource = Record<string, string | undefined>;

const cache = new Map<AnySchema, unknown>();

/**
 * Parses and caches env for one capability. `source` is injectable so tests can
 * assert the missing-variable behavior without mutating the real process env.
 */
export function parseEnv<T>(schema: AnySchema, capability: string, source: EnvSource = process.env): T {
  if (source === process.env) {
    const cached = cache.get(schema);
    if (cached !== undefined) return cached as T;
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = Array.from(
      new Set(
        result.error.issues.map((issue) =>
          issue.code === "invalid_type" && issue.input === undefined ? String(issue.path[0]) : `${String(issue.path[0])} (${issue.message})`,
        ),
      ),
    );
    throw new MissingConfigurationError(capability, missing);
  }

  if (source === process.env) cache.set(schema, result.data);
  return result.data as T;
}

export const databaseEnv = () => parseEnv<DatabaseEnv>(databaseEnvSchema, "Database access");
export const llmEnv = () => parseEnv<LlmEnv>(llmEnvSchema, "LLM calls");
export const embeddingsEnv = () => parseEnv<EmbeddingsEnv>(embeddingsEnvSchema, "Embeddings");
export const observabilityEnv = () =>
  parseEnv<ObservabilityEnv>(observabilityEnvSchema, "Observability");

/** True when the capability is configured — used to pick graceful degradation over a throw. */
export function isConfigured(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

/** Clears the cache — test-only. */
export function resetEnvCache(): void {
  cache.clear();
}
