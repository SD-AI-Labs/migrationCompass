/**
 * Code-aware chunking.
 *
 * The plan carries this forward from V1 as a proven technique, and the technique
 * is specifically: source files get a larger token budget than prose, because a
 * boundary landing mid-function destroys more meaning than one landing
 * mid-paragraph. A spec or a log tolerates being split; a method does not.
 *
 * This is NOT syntax-aware chunking — splitting exactly on method/class
 * boundaries needs a parser per language. It is a size tuning that reduces how
 * often a boundary lands inside a declaration, and the module says so rather
 * than implying more. Pure: no I/O, no dependencies, so the whole thing is
 * verifiable with a test runner and no infrastructure.
 */

export type DocumentKind = "code" | "prose";

export type ChunkBudget = {
  /** Soft ceiling per chunk, in estimated tokens. */
  maxTokens: number;
  /** How much of the previous chunk's tail is repeated at the start of the next. */
  overlapTokens: number;
  /** Chunks below this size are merged into a neighbour rather than emitted alone. */
  minChars: number;
};

/**
 * Sized to match V1's proven values: 1500 tokens for code (roughly 6000 chars),
 * the library default of 800 for prose. Kept in token terms because that is the
 * unit the embedding model and the LLM both actually bound on.
 */
export const CODE_BUDGET: ChunkBudget = { maxTokens: 1500, overlapTokens: 150, minChars: 500 };
export const PROSE_BUDGET: ChunkBudget = { maxTokens: 800, overlapTokens: 80, minChars: 200 };

/**
 * Token estimate from character count. Deliberately approximate: the exact
 * tokenizer differs per model, and this number only drives chunk sizing and a
 * displayed statistic — never a billing or budgeting decision.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function budgetFor(kind: DocumentKind): ChunkBudget {
  return kind === "code" ? CODE_BUDGET : PROSE_BUDGET;
}

/** Splits on blank lines: the one boundary convention that holds across code, markdown, and logs. */
function segments(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Splits a segment that is itself over budget. Splits on line boundaries so a
 * hard split still lands between statements wherever possible; a single line
 * larger than the whole budget (a minified bundle, a giant JSON blob) is the one
 * case where a split lands mid-line, after which there is no better option.
 */
function hardSplit(segment: string, budget: ChunkBudget): string[] {
  const lines = segment.split(/\r?\n/);
  const pieces: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) pieces.push(current.trim());
    current = "";
  };

  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (estimateTokens(candidate) > budget.maxTokens && current.length > 0) {
      flush();
      current = line;
    } else {
      current = candidate;
    }

    // The line alone blew the budget: cut it at roughly maxTokens worth of chars.
    if (estimateTokens(current) > budget.maxTokens) {
      const cut = budget.maxTokens * 4;
      for (let offset = 0; offset < current.length; offset += cut) {
        pushIfNonEmpty(current.slice(offset, offset + cut), pieces);
      }
      current = "";
    }
  }

  flush();
  return pieces;
}

function pushIfNonEmpty(piece: string, pieces: string[]): void {
  if (piece.trim().length > 0) pieces.push(piece.trim());
}

/** Last `overlapTokens` worth of lines from a chunk, used to seed the next one. */
function overlapTail(chunk: string, budget: ChunkBudget): string {
  if (budget.overlapTokens <= 0) return "";
  const lines = chunk.split(/\r?\n/);
  const tail: string[] = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const candidate = [line, ...tail].join("\n");
    if (estimateTokens(candidate) > budget.overlapTokens && tail.length > 0) break;
    tail.unshift(line);
  }

  return tail.join("\n").trim();
}

/**
 * Splits one document into chunks. Returns [] for whitespace-only input rather
 * than a single empty chunk — an empty chunk embeds to a meaningless vector and
 * would be retrievable noise.
 */
export function splitIntoChunks(content: string, budget: ChunkBudget): string[] {
  if (content.trim().length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    current = "";
  };

  for (const segment of segments(content)) {
    const pieces = estimateTokens(segment) > budget.maxTokens ? hardSplit(segment, budget) : [segment];

    for (const piece of pieces) {
      const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;

      if (estimateTokens(candidate) > budget.maxTokens && current.length > 0) {
        const tail = overlapTail(current, budget);
        flush();
        current = tail.length > 0 && estimateTokens(`${tail}\n\n${piece}`) <= budget.maxTokens
          ? `${tail}\n\n${piece}`
          : piece;
      } else {
        current = candidate;
      }
    }
  }

  flush();

  return mergeUndersizedChunks(chunks, budget);
}

/**
 * A trailing sliver carries little retrievable signal on its own and, worse,
 * looks like a complete chunk to whatever reads the scorecard's chunk count.
 * Merged back into its predecessor instead.
 */
function mergeUndersizedChunks(chunks: string[], budget: ChunkBudget): string[] {
  if (chunks.length < 2) return chunks;
  const last = chunks[chunks.length - 1];
  if (last === undefined || last.length >= budget.minChars) return chunks;

  const merged = chunks.slice(0, -1);
  const previous = merged[merged.length - 1];
  if (previous === undefined) return chunks;
  merged[merged.length - 1] = `${previous}\n\n${last}`;
  return merged;
}

export type Chunk = {
  source: string;
  fileName: string;
  documentType: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
};

export type SourceFile = {
  /** Path relative to the archive root — the citation shown to users. */
  path: string;
  fileName: string;
  /** "code" | "log" | "spec" | "schema" | "doc" */
  documentType: string;
  content: string;
};

export function kindOf(documentType: string): DocumentKind {
  return documentType === "code" ? "code" : "prose";
}

/** Chunks one source file, assigning sequential indices within that file. */
export function chunkFile(file: SourceFile): Chunk[] {
  const budget = budgetFor(kindOf(file.documentType));
  return splitIntoChunks(file.content, budget).map((content, chunkIndex) => ({
    source: file.path,
    fileName: file.fileName,
    documentType: file.documentType,
    chunkIndex,
    content,
    tokenCount: estimateTokens(content),
  }));
}

/** Chunks a whole scan result, flattening file order. */
export function chunkFiles(files: SourceFile[]): Chunk[] {
  return files.flatMap(chunkFile);
}
