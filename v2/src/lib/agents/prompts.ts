import { z } from "zod";

import type { LlmPrompt } from "@/lib/llm/client";

import {
  architectureOutputSchema,
  comparisonOutputSchema,
  discoveryOutputSchema,
  riskAssessmentSchema,
} from "./schemas";

/**
 * Every prompt the agent pipeline sends, in one place.
 *
 * Centralized for two reasons. First, the extraction prompts embed a JSON Schema
 * *generated from the zod validators* rather than a hand-written description —
 * so the shape the model is told to produce and the shape it is validated against
 * cannot drift apart, which is the failure mode that hand-written schema text
 * always eventually has.
 *
 * Second, every prompt carries a `tag`. The tag never reaches the model; it lets
 * a test script a model by pipeline step rather than by substring-matching prose,
 * so rewording a prompt does not silently break the tests that cover it.
 */

export const AGENT_STAGES = ["discovery", "architecture", "risk", "comparison"] as const;
export type AgentStage = (typeof AGENT_STAGES)[number];

/** Comparison is an evaluator, not a generator — see COMPLETENESS's absence below. */
export const CRITIQUED_STAGES = ["discovery", "architecture", "risk"] as const;
export type CritiquedStage = (typeof CRITIQUED_STAGES)[number];

export const STAGE_LABELS: Record<AgentStage, string> = {
  discovery: "Discovery Agent",
  architecture: "Architecture Agent",
  risk: "Risk Agent",
  comparison: "Comparison Agent",
};

export const OUTPUT_SCHEMAS: Record<AgentStage, z.ZodType<unknown>> = {
  discovery: discoveryOutputSchema,
  architecture: architectureOutputSchema,
  risk: riskAssessmentSchema,
  comparison: comparisonOutputSchema,
};

export type PromptKind = "draft" | "critique" | "refine" | "extract" | "extract-retry";

export function promptTag(stage: AgentStage, kind: PromptKind): string {
  return `${stage}.${kind}`;
}

/**
 * JSON Schema for a stage's output, generated from its zod validator in *input*
 * mode so optional/defaulted fields are described as optional — the model is
 * being told what it may send, not what the validator will produce after
 * normalization.
 */
export function outputSchemaJson(stage: AgentStage): string {
  const jsonSchema = z.toJSONSchema(OUTPUT_SCHEMAS[stage], { io: "input" });
  // The $schema declaration is noise for a prompt; the model has no use for it.
  const { $schema: _unused, ...rest } = jsonSchema as Record<string, unknown>;
  return JSON.stringify(rest, null, 2);
}

export const COMPLETENESS_CHECKLISTS: Record<CritiquedStage, string> = {
  discovery: [
    "tech stack; service/component inventory using the actual discovered names (not generic placeholders);",
    "database overview if a database exists; messaging/eventing overview if one exists; external integrations if any exist;",
    "observed runtime issues from logs, with specific errors or exceptions cited rather than 'logs exist';",
    "known code-level issues found via the tool, not speculation;",
    "a dependency edge for every relationship discovered — which service calls, imports, publishes to, or reads the same tables as which other service.",
  ].join(" "),
  architecture: [
    "target service/component boundaries explicitly addressed (matching the existing boundaries 1:1, redrawn, or staying as-is — a decision, not silence);",
    "key technology choices grounded in the actual discovered stack and domain, not a generic default stack;",
    "a phased plan if restructuring is warranted, or an explicit statement that the current architecture does not need major changes if that is what the evidence shows;",
    "every recommendation traceable to something the Discovery findings actually reported.",
  ].join(" "),
  risk: [
    "every service named in the Discovery findings was actually checked with the health and traffic tools, or the tool's 'no data' response was noted explicitly rather than silently skipped;",
    "the ranking gives brief evidence-based reasoning per item, not a bare list;",
    "log-observed runtime issues are weighted more heavily than an untested code smell;",
    "no operational number is stated as fact without a tool call actually backing it.",
  ].join(" "),
};

export const STAGE_SYSTEM_PROMPTS: Record<AgentStage, string> = {
  discovery: [
    "You are the Discovery Agent for a legacy/existing system migration project. Your job is to",
    "build an accurate, evidence-based picture of an UNKNOWN codebase BEFORE any migration",
    "planning happens — you have no prior knowledge of what this system is or what it contains.",
    "",
    "You have a tool to query the uploaded codebase's actual source, API specs, database schema,",
    "operational data, and application logs if provided. Use it repeatedly with specific, focused",
    "questions: start broad (what services/components exist?), then go deep on each thing you find —",
    "one focused question per service, one for the database schema, one for messaging, one for",
    "external integrations, one for what the logs show. Do not assume ahead of time how many",
    "services exist, what they are called, or whether logs exist — discover all of it from the tool.",
    "",
    "Also establish how the pieces relate: which service calls which, which services share database",
    "tables, which publish or consume messages, and which call out to external systems. Base every",
    "edge on something the tool actually showed you — a call site, an import, a listener, a shared",
    "table name. Do NOT infer dependencies from directory structure or from how the source tree is",
    "organised: two modules in sibling folders may be entirely unrelated, and a real coupling may",
    "cross folders that look nothing alike.",
    "",
    "Base every claim on what the tool returned. If the tool cannot answer something, say so",
    "explicitly rather than guessing.",
  ].join("\n"),
  architecture: [
    "You are the Architecture Agent for a codebase modernization project. You receive a Discovery",
    "Agent's findings about a codebase — which could be written in ANY language or framework, could",
    "be old or recently written, and could genuinely need significant restructuring OR could already",
    "be well-architected and need only targeted improvements.",
    "",
    "You have the same knowledge-base tool the Discovery Agent used. The Discovery report is a",
    "SUMMARY, not the full picture: if you need to verify a specific detail to make a sound",
    "architectural call — whether two services really share a table, what an integration's error",
    "handling looks like — use the tool yourself rather than guessing. Use it surgically; do not",
    "re-run a full rediscovery.",
    "",
    "CRITICAL — do not default to a specific technology stack, framework, or architectural pattern",
    "(Java, Spring Boot, microservices, a rewrite) unless the Discovery findings actually support it",
    "as the right fit. Ground your proposal in the language and ecosystem already in use, the",
    "system's actual domain and workload, and whether the current architecture has problems that",
    "genuinely justify restructuring. A well-designed monolith may need better test coverage and",
    "dependency updates, not decomposition. Recommending microservices onto a system that does not",
    "need them is bad architecture advice, not thorough planning. If the current architecture is",
    "largely sound, say so plainly.",
  ].join("\n"),
  risk: [
    "You are the Risk Agent for a legacy/existing system migration project. You receive a Discovery",
    "Agent's findings about a codebase and assess migration risk for each service/component it",
    "identified, informed by those findings (including observed runtime issues from logs), by live",
    "operational data where available, and by current health and traffic signals.",
    "",
    "You have tools to check a named service's current health status and traffic statistics. Try",
    "them for every service named in the Discovery findings before producing your assessment — do",
    "not rely on the Discovery findings' description of risk alone. If a tool reports no data",
    "available, that is expected when no operational data was supplied: say so plainly and base the",
    "assessment on code-level and log-based factors instead. Never fabricate operational numbers.",
    "",
    "You also have the Discovery Agent's knowledge-base tool. Use it when a genuine risk-relevant",
    "code detail is not fully covered by the findings — how a specific piece of error handling",
    "behaves, whether a suspected coupling is real — rather than guessing or inflating risk from an",
    "assumption.",
    "",
    "If the findings cite specific errors from logs, weight those heavily: a service with observed",
    "runtime errors is higher risk than one where the same code smell has never actually failed.",
    "Mark explicitly whether each service's rating is backed by log or operational evidence or rests",
    "on static review alone.",
  ].join("\n"),
  comparison: [
    "You are an evaluator comparing an AI migration-planning pipeline's output against a",
    "hand-written expert analysis of the same system (the 'ground truth'). Be specific and honest:",
    "call out what the AI-generated reports got right, what they missed, and anything they got wrong",
    "or overstated. This evaluation exists to demonstrate the pipeline's real accuracy, so do not",
    "soften genuine gaps. If no ground-truth text was available, say so and evaluate internal",
    "consistency instead — what the Discovery and Risk reports agree and disagree about.",
  ].join("\n"),
};

export type StageContext = {
  /** The Discovery narrative. Required for every stage except Discovery itself. */
  discoveryReport?: string;
  architectureProposal?: string;
  riskAssessment?: string;
  /** Ground-truth text, when one exists. Comparison only. */
  groundTruth?: string;
};

function priorFindings(context: StageContext): string {
  const blocks: string[] = [];
  if (context.discoveryReport) {
    blocks.push(`DISCOVERY AGENT FINDINGS:\n---\n${context.discoveryReport}\n---`);
  }
  return blocks.join("\n\n");
}

const INVESTIGATION_TASK = [
  "Investigate the uploaded codebase thoroughly using your knowledge-base tool.",
  "",
  "Start by discovering what services, components, and modules exist and what the overall",
  "architecture looks like — assume nothing in advance. Then go deep on each thing you find: each",
  "service individually, the database schema if one exists, any messaging or eventing layer if one",
  "exists, and any external integrations if any exist. Explicitly ask whether application logs are",
  "available and, if so, what errors, exceptions, or warnings they contain — cite specifics.",
  "",
  "Finally, establish the dependency relationships between the pieces you found, with evidence from",
  "the code for each one.",
  "",
  "Produce your structured written summary covering all of the above, using the actual names you",
  "discovered.",
].join("\n");

export function draftPrompt(stage: AgentStage, context: StageContext): LlmPrompt {
  const system = STAGE_SYSTEM_PROMPTS[stage];

  if (stage === "discovery") {
    return { system, user: INVESTIGATION_TASK, tag: promptTag(stage, "draft") };
  }

  if (stage === "architecture") {
    return {
      system,
      user: [
        priorFindings(context),
        "Propose the target architecture and phased modernization plan for THIS specific system,",
        "grounded in the actual stack, domain, and issues the Discovery findings describe — not a",
        "generic template. Use your knowledge-base tool if you need to verify a specific detail the",
        "findings do not fully cover.",
      ].join("\n"),
      tag: promptTag(stage, "draft"),
    };
  }

  if (stage === "risk") {
    return {
      system,
      user: [
        priorFindings(context),
        "Using your health and traffic tools for each service named above, and your knowledge-base",
        "tool for any risk-relevant detail the findings do not fully cover, produce a risk-ranked",
        "migration assessment. Cover every service you found, highest risk first, with brief",
        "evidence-based reasoning per item.",
      ].join("\n"),
      tag: promptTag(stage, "draft"),
    };
  }

  const comparisonInputs = [
    context.groundTruth
      ? `GROUND TRUTH (hand-written expert analysis):\n---\n${context.groundTruth}\n---`
      : "No ground-truth text is available for this project. Evaluate internal consistency between the reports instead, and say so explicitly.",
    context.discoveryReport
      ? `AI-GENERATED DISCOVERY REPORT:\n---\n${context.discoveryReport}\n---`
      : "",
    context.architectureProposal
      ? `AI-GENERATED ARCHITECTURE PROPOSAL:\n---\n${context.architectureProposal}\n---`
      : "",
    context.riskAssessment
      ? `AI-GENERATED RISK ASSESSMENT:\n---\n${context.riskAssessment}\n---`
      : "",
  ].filter(Boolean);

  return {
    system,
    user: [
      ...comparisonInputs,
      "Compare the AI-generated reports against the reference. Cover: what was correctly identified",
      "(cite the matching points), what was missed entirely, anything stated with unwarranted",
      "confidence, and an overall accuracy assessment.",
    ].join("\n\n"),
    tag: promptTag(stage, "draft"),
  };
}

export function critiquePrompt(stage: CritiquedStage, draft: string, context: StageContext): LlmPrompt {
  const checklist = COMPLETENESS_CHECKLISTS[stage];

  return {
    system: STAGE_SYSTEM_PROMPTS[stage],
    user: [
      `Review the following ${STAGE_LABELS[stage]} report YOU JUST WROTE against this completeness checklist:`,
      checklist,
      "",
      stage === "discovery" ? "" : priorFindings(context),
      "YOUR REPORT:",
      "---",
      draft,
      "---",
      "",
      "If the report genuinely covers every applicable item on the checklist (an item does not apply",
      "if the system genuinely has no database, no messaging, and so on — that is fine, just confirm",
      "it was actually checked rather than silently omitted), respond with EXACTLY the single word:",
      "",
      "COMPLETE",
      "",
      "Otherwise respond with a concise bullet list of the SPECIFIC gaps — what is missing or",
      "under-investigated, not general feedback. Do not rewrite the report here; just identify what",
      "is missing.",
    ].join("\n"),
    temperature: 0,
    tag: promptTag(stage, "critique"),
  };
}

export function refinePrompt(
  stage: CritiquedStage,
  draft: string,
  gaps: string,
  context: StageContext,
): LlmPrompt {
  return {
    system: STAGE_SYSTEM_PROMPTS[stage],
    user: [
      "Your initial report is below, along with specific gaps your own review identified. Use your",
      "tools as needed to investigate EXACTLY those gaps, then produce a REVISED, complete final",
      "report incorporating both your original findings and whatever you find. Do not merely append",
      "notes — integrate everything into one coherent report in the same structure as before.",
      "",
      stage === "discovery" ? "" : priorFindings(context),
      "INITIAL REPORT:",
      "---",
      draft,
      "---",
      "",
      "GAPS TO ADDRESS:",
      "---",
      gaps,
      "---",
    ].join("\n"),
    tag: promptTag(stage, "refine"),
  };
}

export function extractionPrompt(stage: AgentStage, narrative: string): LlmPrompt {
  return {
    system: [
      "You convert an analyst's written report into a single strict JSON object.",
      "Output ONLY the JSON object — no prose, no explanation, no code fences.",
      "Every field in the schema is required unless it is marked optional or has a default.",
      "Do not invent services, dependencies, or numbers that the report does not support; if the",
      "report does not state something the schema asks for, use the most conservative value the",
      "report's evidence justifies and keep it consistent with the rest of the report.",
    ].join(" "),
    user: [
      `Convert the following ${STAGE_LABELS[stage]} report into JSON matching this schema:`,
      "",
      outputSchemaJson(stage),
      "",
      "REPORT:",
      "---",
      narrative,
      "---",
    ].join("\n"),
    temperature: 0,
    tag: promptTag(stage, "extract"),
  };
}

/**
 * The retry prompt, sent once after a validation failure.
 *
 * The validator's own error messages are fed back verbatim rather than being
 * paraphrased. They name the exact field and what was wrong with it, which is
 * precisely the information a model needs to correct itself — paraphrasing would
 * only reintroduce the ambiguity that caused the failure.
 */
export function extractionRetryPrompt(
  stage: AgentStage,
  narrative: string,
  validationError: string,
): LlmPrompt {
  return {
    system: [
      "You convert an analyst's written report into a single strict JSON object.",
      "Your previous attempt was rejected by a validator. Fix exactly what the validator reported.",
      "Output ONLY the JSON object — no prose, no explanation, no code fences.",
    ].join(" "),
    user: [
      "The previous conversion failed validation with this error:",
      validationError,
      "",
      "Convert the report again, producing JSON matching this schema:",
      outputSchemaJson(stage),
      "",
      "REPORT:",
      "---",
      narrative,
      "---",
    ].join("\n"),
    temperature: 0,
    tag: promptTag(stage, "extract-retry"),
  };
}
