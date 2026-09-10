import { z } from "zod";

/**
 * The structured contract between the agent pipeline and everything downstream.
 *
 * This is the M4-facing boundary, and it is deliberately the most validated part
 * of the pipeline. The plan's position is that the dependency graph and the
 * scoring rubric consume *structured findings*, never prose that gets
 * text-sniffed later — so the shape defined here is what the rubric's inputs are
 * built from, and a field that is missing here is a number that cannot be
 * computed later.
 *
 * Two rules that shape the code:
 *
 * 1. **Model output is validated, not trusted.** `parseAgentOutput` extracts JSON
 *    from a model response, parses it, and runs it through a zod schema. A
 *    response that is almost-right is a failure to be retried, not something to
 *    coerce into shape.
 * 2. **Enum values are normalized where a model's phrasing is genuinely
 *    ambiguous, and marked `unknown` where it is not.** "synchronous call",
 *    "sync-call" and "rest" all mean one thing; anything unrecognised becomes
 *    `unknown` rather than being silently dropped, because a dropped edge is a
 *    missing edge in the dependency graph and therefore a wrong risk score.
 */

export const DEPENDENCY_TYPES = [
  "sync_call",
  "async_event",
  "shared_db",
  "external_api",
  "unknown",
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Maps the many ways a model phrases a relationship onto the five values the
 * `dependency_type` column accepts. Pure and exported, because a mis-mapped type
 * changes how the dependency graph is drawn and how blast radius is computed.
 *
 * Order matters and is not arbitrary: "asynchronous" is checked before
 * "synchronous" because substring matching would otherwise classify an event
 * relationship as a call — and async-before-shared because "database" appears in
 * phrases like "synchronous database call", where the mechanism is the meaningful
 * part.
 */
export function normalizeDependencyType(raw: string | null | undefined): DependencyType {
  if (!raw) return "unknown";
  const value = raw.toLowerCase().replace(/[\s-]+/g, "_");

  if (/(async|asynchronous|event|message|messaging|queue|jms|kafka|pub|sub|topic|listener)/.test(value)) {
    return "async_event";
  }
  if (/(sync|synchronous|rest|http|grpc|rpc|call|request|invoke)/.test(value)) {
    return "sync_call";
  }
  if (/(shared|database|db|table|schema|datastore|sql|oracle|postgres|mysql)/.test(value)) {
    return "shared_db";
  }
  return "unknown";
}

/** External integrations are identified by destination, checked before mechanism. */
function isExternal(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /(external|third_party|vendor|partner|saas|outside)/.test(raw.toLowerCase());
}

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

export const dependencySchema = z
  .object({
    from: trimmedString(200),
    to: trimmedString(200),
    /** Free text from the model; normalized rather than rejected. */
    type: z.string().max(80).optional(),
    /** Static-analysis evidence for the edge, so it is never an unfalsifiable claim. */
    evidence: z.string().max(600).optional(),
  })
  .transform((edge) => {
    const rawType = edge.type ?? "";
    return {
      from: edge.from,
      to: edge.to,
      type: isExternal(rawType) ? ("external_api" as const) : normalizeDependencyType(rawType),
      evidence: edge.evidence,
    };
  });

export type Dependency = z.infer<typeof dependencySchema>;

export const serviceFindingSchema = z.object({
  name: trimmedString(200),
  riskLevel: z.enum(RISK_LEVELS),
  riskFactors: z.array(z.string().max(500)).default([]),
  recommendation: z.string().max(1000).optional(),
  /**
   * The rubric's three structured inputs. Required rather than defaulted: a
   * silently-defaulted `false` would read as "no test-coverage gap", which is a
   * claim the model never made, and the readiness score is computed from exactly
   * these values.
   */
  hasTestCoverageGap: z.boolean(),
  dataQualityIssueCount: z.number().int().min(0).max(10_000),
  requiresMajorRestructuring: z.boolean(),
});

export type ServiceFinding = z.infer<typeof serviceFindingSchema>;

export const discoveryOutputSchema = z.object({
  systemName: z.string().max(200).optional(),
  summary: trimmedString(4000),
  services: z.array(serviceFindingSchema).min(1),
  dependencies: z.array(dependencySchema).default([]),
  techStack: z.array(z.string().max(200)).default([]),
  databaseOverview: z.string().max(2000).optional(),
  messagingOverview: z.string().max(2000).optional(),
  externalIntegrations: z.string().max(2000).optional(),
  runtimeIssues: z.string().max(2000).optional(),
});

export type DiscoveryOutput = z.infer<typeof discoveryOutputSchema>;

export const migrationPhaseSchema = z.object({
  phaseNumber: z.number().int().min(1),
  title: trimmedString(200),
  servicesInvolved: z.array(z.string().max(200)).default([]),
  rationale: z.string().max(1500).optional(),
});

export const architectureOutputSchema = z.object({
  migrationApproach: trimmedString(2000),
  proposedServices: z.array(z.string().max(200)).default([]),
  keyTechnologyChoices: z.array(z.string().max(300)).default([]),
  /**
   * The plan calls for an explicit "current architecture is largely sound"
   * finding rather than inferring soundness from the absence of complaints — an
   * unstated opinion and a stated one are different inputs to the readiness
   * score.
   */
  currentArchitectureLargelySound: z.boolean(),
  phasedPlan: z.array(migrationPhaseSchema).default([]),
});

export type ArchitectureOutput = z.infer<typeof architectureOutputSchema>;

export const EVIDENCE_SOURCES = ["logs", "operational_data", "static_analysis", "none"] as const;

export const riskAssessmentSchema = z.object({
  ranked: z
    .array(
      z.object({
        serviceName: trimmedString(200),
        riskLevel: z.enum(RISK_LEVELS),
        reasoning: z.string().max(1500),
        /** Mirrors V1's rule that operational evidence outweighs a code smell. */
        evidenceSource: z.enum(EVIDENCE_SOURCES).default("static_analysis"),
      }),
    )
    .min(1),
  operationalDataAvailable: z.boolean().default(false),
});

export type RiskOutput = z.infer<typeof riskAssessmentSchema>;

export const comparisonOutputSchema = z.object({
  matched: z.array(z.string().max(500)).default([]),
  missed: z.array(z.string().max(500)).default([]),
  incorrect: z.array(z.string().max(500)).default([]),
  accuracyAssessment: trimmedString(4000),
});

export type ComparisonOutput = z.infer<typeof comparisonOutputSchema>;

/** Raised when a model response cannot be turned into a valid structured output. */
export class AgentOutputError extends Error {
  constructor(
    readonly label: string,
    readonly reason: string,
    readonly excerpt: string,
  ) {
    super(`${label}: ${reason} Response excerpt: ${excerpt}`);
    this.name = "AgentOutputError";
  }
}

const MAX_EXCERPT = 400;

/**
 * Pulls a JSON object out of a model response.
 *
 * Models wrap JSON in prose and code fences no matter how they are asked, so
 * extraction is by brace depth rather than by fence markers — a fence is a
 * convention, balanced braces are a fact about the text. Depth tracking respects
 * string literals so a brace inside a value does not end the scan early.
 */
export function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function excerptOf(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_EXCERPT ? `${collapsed.slice(0, MAX_EXCERPT)}…` : collapsed;
}

/**
 * Extracts, parses, and validates a model response against a schema.
 * Throws `AgentOutputError` with a diagnostic that is safe to log and to send
 * back to the model on a retry.
 */
export function parseAgentOutput<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  const json = extractJsonObject(raw);
  if (json === null) {
    throw new AgentOutputError(label, "no JSON object found in the response.", excerptOf(raw));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new AgentOutputError(
      label,
      `the JSON object did not parse (${error instanceof Error ? error.message : "unknown"}).`,
      excerptOf(json),
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AgentOutputError(label, `it failed validation (${issues}).`, excerptOf(json));
  }

  return result.data;
}

/**
 * Removes self-edges and duplicate edges, keeping the first occurrence.
 *
 * A self-edge is not a dependency, and a duplicate adds no information but would
 * double-count in the dependent-count aggregation. Both are dropped for the same
 * reason: the graph's edges feed a risk weight, so noise in the edge list is
 * noise in the score.
 */
export function normalizeDependencies(dependencies: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  const normalized: Dependency[] = [];

  for (const dependency of dependencies) {
    if (dependency.from === dependency.to) continue;
    const key = `${dependency.from}\u0000${dependency.to}\u0000${dependency.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(dependency);
  }

  return normalized;
}
