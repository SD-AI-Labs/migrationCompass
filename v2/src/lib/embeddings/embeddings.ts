import { embeddingsEnv } from "@/lib/env";

/**
 * Embeddings behind an interface, for one reason: the retrieval and ingestion
 * pipelines need to be testable without a running Ollama. The real provider is
 * a thin HTTP client; the stub is deterministic and produces unit-normalized
 * vectors, so cosine-similarity logic can be tested against known geometry
 * rather than against whatever a model happens to emit.
 */

export type EmbeddingProvider = {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

/** Ollama's batch embedding endpoint. Same local model family the plan carries forward. */
export async function embedWithOllama(
  texts: string[],
  options: { baseUrl: string; model: string; signal?: AbortSignal },
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await fetch(new URL("/api/embed", options.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, input: texts }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama embeddings request failed (${response.status} ${response.statusText}). ` +
        `Is Ollama running and has '${options.model}' been pulled? ${body.slice(0, 500)}`,
    );
  }

  const payload = (await response.json()) as { embeddings?: number[][] };
  if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${payload.embeddings?.length ?? 0} embeddings for ${texts.length} inputs.`,
    );
  }

  return payload.embeddings;
}

export function createOllamaEmbeddings(): EmbeddingProvider {
  const env = embeddingsEnv();
  return {
    name: `ollama:${env.EMBEDDING_MODEL}`,
    dimensions: env.EMBEDDING_DIMENSIONS,
    embed: (texts) =>
      embedWithOllama(texts, { baseUrl: env.OLLAMA_BASE_URL, model: env.EMBEDDING_MODEL }),
  };
}

/** FNV-1a, used only to seed the stub's PRNG. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic stand-in. Two texts with the same leading characters produce
 * similar vectors and unrelated texts produce near-orthogonal ones, which is
 * enough structure for retrieval tests to behave realistically.
 */
export function createStubEmbeddings(dimensions = 8): EmbeddingProvider {
  return {
    name: "stub",
    dimensions,
    embed: async (texts) =>
      texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
        for (const token of tokens) {
          const hash = fnv1a(token);
          // Two dimensions per token, so two different texts whose tokens collide
          // on the first dimension do not collapse onto the same direction.
          const primary = hash % dimensions;
          const secondary = (hash >>> 8) % dimensions;
          vector[primary] = (vector[primary] ?? 0) + 1;
          vector[secondary] = (vector[secondary] ?? 0) + 0.5;
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return norm === 0 ? vector : vector.map((value) => value / norm);
      }),
  };
}

/** Embeds in batches, so a large upload does not become one enormous request. */
export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  batchSize = 32,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    vectors.push(...(await provider.embed(batch)));
  }
  return vectors;
}
