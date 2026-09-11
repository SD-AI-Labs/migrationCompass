import { normalizeServiceKey } from "@/lib/agents/persistence";
import { edgeLabelFor, type DependencyGraphModel } from "@/lib/graph/build-graph";
import type { ProjectSummary } from "@/lib/projects/repository";
import {
  OPERATIONAL_RISK,
  RISK_LEVELS,
  RISK_LEVEL_VALUES,
  describeAssumptions,
} from "@/lib/scoring/assumptions";
import { SCORE_NAMES, type ScoreExplanation } from "@/lib/scoring/explain";
import { formatScoreValue } from "@/lib/scoring/format";
import { describeSignals, type OperationalAdjustment, type OperationalSignals } from "@/lib/scoring/operational";
import type { ParameterAssessment } from "@/lib/scoring/parameters";
import type { LoadedScorecard } from "@/lib/scoring/loader";

import type {
  AnalysisReport,
  IndexedSourceListing,
  ReportAsk,
  ReportCount,
  ReportItem,
  ReportSection,
  ReportTone,
} from "./types";

/**
 * Composes the Analysis Report.
 *
 * Pure and deterministic: given the same persisted analysis it produces the same
 * report, which is what makes the section tests meaningful and what keeps the
 * report out of the "a model wrote something plausible" category. It reads four
 * things and nothing else:
 *
 *  1. the validated structured outputs of the run (discovery, architecture, risk,
 *     comparison) as the loader parsed them;
 *  2. the persisted findings and dependency edges;
 *  3. the dependency graph model — the *same* `buildDependencyGraph()` the graph
 *     view renders, so coupling statements and the picture cannot disagree;
 *  4. the deterministic scorecard and its explanations, formatted through the same
 *     functions the scorecard uses, so a number cannot read two ways.
 *
 * It never calls a model, never re-derives a score, and never states a conclusion
 * the data does not carry: a section with nothing to say says so.
 */

export type ReportInput = {
  project: ProjectSummary;
  loaded: LoadedScorecard;
  graph: DependencyGraphModel;
  sources: IndexedSourceListing;
};

/**
 * How many items a list may carry before it is elided.
 *
 * Disclosure handles length, but a hundred-row list inside a disclosure is still a
 * hundred-row list — the cap keeps a section readable and the elision is stated
 * rather than silent.
 */
export const MAX_ITEMS_PER_LIST = 40;

/**
 * Readiness bands, used only to phrase the executive summary's posture sentence.
 *
 * These are presentation, not scoring: the thresholds sit on the readiness scale
 * the rubric already produces and change no number. The sentence always prints the
 * readiness and risk values themselves, so the reader sees the basis of the band.
 */
const POSTURE_BANDS: { minReadiness: number; label: string; consequence: string }[] = [
  {
    minReadiness: 70,
    label: "broadly ready",
    consequence: "the assessment found few structural obstacles",
  },
  {
    minReadiness: 50,
    label: "migratable with focused remediation",
    consequence: "the obstacles are concentrated rather than systemic",
  },
  {
    minReadiness: 30,
    label: "significant remediation required",
    consequence: "structural work is needed before a migration can be sequenced safely",
  },
  {
    minReadiness: 0,
    label: "high risk",
    consequence: "the assessment recorded obstacles that need resolving before scheduling work",
  },
];

const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  logs: "operational logs supplied with the project",
  operational_data: "operational data supplied with the project",
  static_analysis: "static analysis of the source",
  none: "no evidence was recorded for this rating",
};

function postureFor(readiness: number): { label: string; consequence: string } {
  const band = POSTURE_BANDS.find((candidate) => readiness >= candidate.minReadiness);
  return band ?? (POSTURE_BANDS[POSTURE_BANDS.length - 1] as (typeof POSTURE_BANDS)[number]);
}

/** A comma list with a deterministic cap, stating how many were left out. */
function joinList(values: string[], max = 6): string {
  if (values.length === 0) return "";
  if (values.length <= max) return values.join(", ");
  return `${values.slice(0, max).join(", ")} and ${values.length - max} more`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Items capped with a stated elision, so nothing is dropped silently. */
function capped(items: ReportItem[], cap = MAX_ITEMS_PER_LIST): ReportItem[] {
  return items.length > cap ? items.slice(0, cap) : items;
}

function elisionNote(total: number, cap = MAX_ITEMS_PER_LIST): string[] {
  return total > cap ? [`showing the first ${cap} of ${total}`] : [];
}

// ─── Executive summary ──────────────────────────────────────────────────────

function executiveSummaryParagraphs(input: ReportInput): string[] {
  const { project, loaded, graph } = input;
  const { scorecard, explanation, outputs, input: scoringInput } = loaded;
  const discovery = outputs.discovery;
  const architecture = outputs.architecture;

  const serviceCount = scoringInput.findings.length;
  const edgeCount = scoringInput.dependencies.length;
  const systemName = discovery?.systemName ?? project.name;

  const paragraphs: string[] = [];

  paragraphs.push(
    discovery
      ? `${discovery.summary}`
      : `No Discovery output was persisted for this run, so the inventory below is the ${plural(serviceCount, "service finding")} and ${plural(edgeCount, "dependency edge")} the run recorded.`,
  );

  const posture = postureFor(scorecard.readiness);
  paragraphs.push(
    `${systemName} is assessed at ${formatScoreValue(explanation.scores.readiness)} migration readiness and ` +
      `${formatScoreValue(explanation.scores.risk)} risk across ${plural(serviceCount, "service finding")} and ` +
      `${plural(edgeCount, "dependency edge")} — ${posture.label}, so ${posture.consequence}. ` +
      `${scorecard.confidence.label}; the rubric's evidence quality is ${explanation.evidence.level}.`,
  );

  const ranked = rankedSeverity(loaded);
  // "Most serious concern" means the worst rating, not merely the first finding: a
  // run where everything is low should say so rather than dress a low up as a
  // concern.
  const topConcern = ranked.find(
    (finding) => finding.riskLevel === "critical" || finding.riskLevel === "high",
  );

  if (topConcern) {
    paragraphs.push(
      `The most serious recorded concern is ${topConcern.serviceName} at ${topConcern.riskLevel} risk` +
        `${topConcern.reason ? ` — ${topConcern.reason}` : "."}`,
    );
  } else if (ranked[0]) {
    paragraphs.push(
      `No service was rated critical or high in this run; the highest recorded level is ${ranked[0].riskLevel} (${ranked[0].serviceName}).`,
    );
  } else {
    paragraphs.push("No service findings were recorded, so no risk level was assessed.");
  }

  if (graph.cycles.length > 0) {
    paragraphs.push(
      `The dependency graph contains ${plural(graph.cycles.length, "circular dependency chain")}, which limits how far the services in those chains can be migrated independently.`,
    );
  }

  if (architecture) {
    paragraphs.push(
      `The recorded migration approach is: ${architecture.migrationApproach} ` +
        `The Architecture stage states that the current architecture is ${architecture.currentArchitectureLargelySound ? "" : "not "}largely sound.`,
    );
    const firstPhase = [...architecture.phasedPlan].sort((a, b) => a.phaseNumber - b.phaseNumber)[0];
    if (firstPhase) {
      paragraphs.push(
        `Migration is planned in ${plural(architecture.phasedPlan.length, "phase")}; phase ${firstPhase.phaseNumber} is “${firstPhase.title}”.`,
      );
    }
  }

  return paragraphs;
}

function executiveSummaryHighlights(input: ReportInput): ReportItem[] {
  const { loaded, graph } = input;
  const highlights: ReportItem[] = [];

  for (const finding of rankedSeverity(loaded).slice(0, 4)) {
    highlights.push({
      id: `highlight-risk-${finding.key}`,
      label: `${finding.serviceName} — ${finding.riskLevel} risk`,
      detail:
        finding.reason ??
        finding.recommendation ??
        "Recorded at this level by the Risk stage; no reasoning text was persisted.",
      tone: finding.riskLevel,
      evidence: finding.evidence,
      ask: {
        question: `Why is ${finding.serviceName} rated ${finding.riskLevel}, and what evidence supports that rating?`,
        context: `Report · Key finding: ${finding.serviceName} (${finding.riskLevel} risk)`,
      },
    });
  }

  for (const cycle of graph.cycles.slice(0, 2)) {
    highlights.push({
      id: `highlight-cycle-${cycle.join("->")}`,
      label: "Circular dependency",
      detail: `${cycle.map(labelOf(graph)).join(" → ")} — a change in this chain reaches everything in it.`,
      tone: "high",
      evidence: [`${cycle.length} services in the cycle`],
    });
  }

  const restructuring = loaded.input.findings.filter((finding) => finding.requiresMajorRestructuring);
  if (restructuring.length > 0) {
    highlights.push({
      id: "highlight-restructuring",
      label: `${plural(restructuring.length, "service")} require major restructuring`,
      detail: `${joinList(restructuring.map((finding) => finding.serviceName))} were recorded as needing major restructuring before migration.`,
      tone: "high",
      evidence: [`${restructuring.length} of ${loaded.input.findings.length} findings`],
    });
  }

  const coverageGaps = loaded.input.findings.filter((finding) => finding.hasTestCoverageGap);
  if (coverageGaps.length > 0) {
    highlights.push({
      id: "highlight-coverage",
      label: `${plural(coverageGaps.length, "service")} with a test-coverage gap`,
      detail: `${joinList(coverageGaps.map((finding) => finding.serviceName))} carry a test-coverage gap, which is a rubric input to readiness and effort.`,
      tone: "medium",
      evidence: [`${coverageGaps.length} of ${loaded.input.findings.length} findings`],
    });
  }

  return highlights;
}

function labelOf(graph: DependencyGraphModel) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return (id: string): string => labels.get(id) ?? id;
}

/**
 * A graph node's risk level as a report tone.
 *
 * `unknown` is a real state — the node appears in an edge but was never rated —
 * and it maps to the neutral tone rather than to a severity, because colouring an
 * unrated service as if it had been assessed is the one thing the graph model
 * refuses to do.
 */
function graphTone(riskLevel: string): ReportTone {
  return riskLevel === "critical" || riskLevel === "high" || riskLevel === "medium" || riskLevel === "low"
    ? riskLevel
    : "neutral";
}

/** Findings ordered most severe first, then by how many services depend on them. */
function rankedSeverity(loaded: LoadedScorecard) {
  const riskByService = new Map(
    (loaded.outputs.risk?.ranked ?? []).map((entry) => [normalizeServiceKey(entry.serviceName), entry]),
  );
  const { factors } = evidenceIndex(loaded);

  return [...loaded.input.findings]
    .sort((a, b) => {
      const byLevel = RISK_LEVELS.indexOf(a.riskLevel) - RISK_LEVELS.indexOf(b.riskLevel);
      if (byLevel !== 0) return byLevel;
      const byDependents = b.dependentCount - a.dependentCount;
      if (byDependents !== 0) return byDependents;
      return a.serviceName.localeCompare(b.serviceName);
    })
    .map((finding) => {
      const key = normalizeServiceKey(finding.serviceName);
      const entry = riskByService.get(key);
      const detail = factors.get(key);

      const evidence: string[] = [];
      evidence.push(`rubric level value ${RISK_LEVEL_VALUES[finding.riskLevel]}/100`);
      evidence.push(`${plural(finding.dependentCount, "dependent service")}`);
      if (finding.hasTestCoverageGap) evidence.push("recorded test-coverage gap");
      if (finding.requiresMajorRestructuring) evidence.push("recorded as needing major restructuring");
      if (finding.dataQualityIssueCount > 0) {
        evidence.push(`${plural(finding.dataQualityIssueCount, "recorded data-quality issue")}`);
      }
      if (entry) {
        evidence.push(`rating evidence: ${EVIDENCE_SOURCE_LABELS[entry.evidenceSource] ?? entry.evidenceSource}`);
      }
      for (const factor of (detail?.riskFactors ?? []).slice(0, 4)) evidence.push(factor);

      return {
        key,
        serviceName: finding.serviceName,
        riskLevel: finding.riskLevel,
        /** The structured rubric inputs, so a caller never has to parse the evidence lines. */
        hasTestCoverageGap: finding.hasTestCoverageGap,
        requiresMajorRestructuring: finding.requiresMajorRestructuring,
        dataQualityIssueCount: finding.dataQualityIssueCount,
        dependentCount: finding.dependentCount,
        reason: entry?.reasoning ?? null,
        recommendation: detail?.recommendation ?? null,
        evidence,
      };
    });
}

/**
 * The prose behind each finding, indexed by normalized service key.
 *
 * The rubric's input types are deliberately narrow — `ScoringFinding` carries the
 * structured fields the arithmetic needs and drops the narrative — so the risk
 * factors, recommendations and per-edge evidence are read from the validated
 * structured outputs, which is where they were persisted. Joining on the same
 * normalized key the persistence layer uses is what stops a finding being
 * explained by another service's text.
 */
function evidenceIndex(loaded: LoadedScorecard): {
  factors: Map<string, { riskFactors: string[]; recommendation: string | null }>;
  edgeEvidence: Map<string, string>;
} {
  const discovery = loaded.outputs.discovery;

  const factors = new Map<string, { riskFactors: string[]; recommendation: string | null }>();
  for (const service of discovery?.services ?? []) {
    factors.set(normalizeServiceKey(service.name), {
      riskFactors: service.riskFactors,
      recommendation: service.recommendation ?? null,
    });
  }

  const edgeEvidence = new Map<string, string>();
  for (const edge of discovery?.dependencies ?? []) {
    if (!edge.evidence) continue;
    edgeEvidence.set(edgeEvidenceKey(edge.from, edge.to), edge.evidence);
  }

  return { factors, edgeEvidence };
}

function edgeEvidenceKey(from: string, to: string): string {
  return `${normalizeServiceKey(from)}|${normalizeServiceKey(to)}`;
}

// ─── Sections ───────────────────────────────────────────────────────────────

function discoverySection(input: ReportInput): ReportSection {
  const { project, loaded } = input;
  const discovery = loaded.outputs.discovery;
  const findings = loaded.input.findings;
  const { factors } = evidenceIndex(loaded);

  const items: ReportItem[] = [];

  if (discovery) {
    items.push({
      id: "discovery-summary",
      label: discovery.systemName ?? project.name,
      detail: discovery.summary,
      tone: "neutral",
      evidence: elisionNote(0),
    });
  }

  for (const finding of [...findings].sort((a, b) => a.serviceName.localeCompare(b.serviceName))) {
    const traits: string[] = [`${finding.riskLevel} risk`];
    if (finding.hasTestCoverageGap) traits.push("test-coverage gap");
    if (finding.requiresMajorRestructuring) traits.push("needs major restructuring");
    if (finding.dataQualityIssueCount > 0) traits.push(`${finding.dataQualityIssueCount} data-quality issue(s)`);
    traits.push(`${plural(finding.dependentCount, "dependent")}`);

    items.push({
      id: `discovery-service-${normalizeServiceKey(finding.serviceName)}`,
      label: finding.serviceName,
      detail: traits.join(" · "),
      tone: finding.riskLevel,
      evidence: (factors.get(normalizeServiceKey(finding.serviceName))?.riskFactors ?? []).slice(0, 4),
    });
  }

  if (discovery) {
    const overviews: { id: string; label: string; text?: string }[] = [
      { id: "database", label: "Database and storage", text: discovery.databaseOverview },
      { id: "messaging", label: "Messaging", text: discovery.messagingOverview },
      { id: "external", label: "External integrations", text: discovery.externalIntegrations },
      { id: "runtime", label: "Runtime issues", text: discovery.runtimeIssues },
    ];

    for (const overview of overviews) {
      if (!overview.text) continue;
      items.push({
        id: `discovery-${overview.id}`,
        label: overview.label,
        detail: overview.text,
        tone: "neutral",
        evidence: [],
      });
    }

    if (discovery.techStack.length > 0) {
      items.push({
        id: "discovery-tech-stack",
        label: `Technology stack (${discovery.techStack.length})`,
        detail: joinList(discovery.techStack, 12),
        tone: "neutral",
        evidence: [],
      });
    }
  }

  const edgeTypes = Object.keys(countBy(loaded.input.dependencies.map((edge) => edge.type)));
  const counts: ReportCount[] = [
    { label: "Services", value: String(findings.length) },
    { label: "Dependency edges", value: String(loaded.input.dependencies.length) },
    { label: "Edge types", value: edgeTypes.length > 0 ? edgeTypes.join(", ") : "none recorded" },
    { label: "Indexed files", value: String(project.fileCount) },
    { label: "Chunks", value: String(project.chunkCount) },
  ];

  return {
    id: "discovery",
    title: "System Discovery",
    summary: discovery
      ? `${discovery.summary.slice(0, 240)}${discovery.summary.length > 240 ? "…" : ""}`
      : `No Discovery output was persisted, so this lists what the run recorded: ${plural(findings.length, "service finding")} and ${plural(loaded.input.dependencies.length, "dependency edge")}.`,
    counts,
    items: capped(items),
    emptyNote:
      "No services or dependencies were recorded for this run, so there is nothing to describe.",
    ask: {
      question: `What services and technologies were discovered in ${project.name}, and what is unclear about them?`,
      context: `Report · System Discovery: ${plural(findings.length, "service")}, ${plural(loaded.input.dependencies.length, "dependency edge")}`,
    },
  };
}

function architectureSection(input: ReportInput): ReportSection {
  const { project, loaded, graph } = input;
  const architecture = loaded.outputs.architecture;
  const label = labelOf(graph);

  const items: ReportItem[] = [];

  if (architecture) {
    items.push({
      id: "architecture-approach",
      label: "Recorded migration approach",
      detail: architecture.migrationApproach,
      tone: "neutral",
      evidence: architecture.keyTechnologyChoices.length > 0 ? [`technology choices: ${joinList(architecture.keyTechnologyChoices, 8)}`] : [],
    });

    items.push({
      id: "architecture-soundness",
      label: `Current architecture ${architecture.currentArchitectureLargelySound ? "largely sound" : "not stated to be sound"}`,
      detail: architecture.currentArchitectureLargelySound
        ? "The Architecture stage stated the current architecture is largely sound; this is the one rubric input that raises readiness."
        : "The Architecture stage did not state that the current architecture is largely sound — an unstated opinion is not evidence for one.",
      tone: architecture.currentArchitectureLargelySound ? "positive" : "medium",
      evidence: architecture.proposedServices.length > 0
        ? [`${plural(architecture.proposedServices.length, "proposed service")}: ${joinList(architecture.proposedServices, 8)}`]
        : [],
    });
  }

  const dependents = [...graph.nodes]
    .filter((node) => node.incoming > 0)
    .sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id))
    .slice(0, 3);

  for (const node of dependents) {
    items.push({
      id: `architecture-fanin-${node.id}`,
      label: `${node.label} — ${plural(node.incoming, "dependent")}`,
      detail: `${plural(node.incoming, "other service")} name it as a dependency, so a change to it reaches all of them at once.`,
      tone: graphTone(node.riskLevel),
      evidence: [`${plural(node.outgoing, "outgoing dependency", "outgoing dependencies")} recorded`, `layout layer ${node.depth}`],
    });
  }

  const chatter = [...graph.nodes]
    .filter((node) => node.outgoing > 1)
    .sort((a, b) => b.outgoing - a.outgoing || a.id.localeCompare(b.id))
    .slice(0, 2);

  for (const node of chatter) {
    items.push({
      id: `architecture-fanout-${node.id}`,
      label: `${node.label} — ${plural(node.outgoing, "dependency", "dependencies")}`,
      detail: `${node.label} reaches ${plural(node.outgoing, "other service")} directly, which is where a seam has to be decided before either side moves.`,
      tone: "neutral",
      evidence: [],
    });
  }

  for (const cycle of graph.cycles) {
    items.push({
      id: `architecture-cycle-${cycle.join("-")}`,
      label: "Circular dependency",
      detail: `${cycle.map(label).join(" → ")} — the services in this chain depend on each other, so they cannot be cut apart one at a time.`,
      tone: "high",
      evidence: [`${cycle.length} services`],
    });
  }

  const chain = longestChain(graph, label);
  if (chain.length > 1) {
    items.push({
      id: "architecture-critical-path",
      label: `Longest dependency chain (${chain.length} services)`,
      detail: `${chain.join(" → ")} — the deepest chain the recorded edges form, and therefore the sequence a partial migration has to respect.`,
      tone: "neutral",
      evidence: [`derived from the graph's own layering`],
    });
  }

  if (graph.isolated.length > 0) {
    items.push({
      id: "architecture-isolated",
      label: `${plural(graph.isolated.length, "service")} with no recorded relationships`,
      detail: `${joinList(graph.isolated.map(label), 8)} appear in no dependency edge. Either they are genuinely standalone or their relationships were not extracted — the analysis cannot distinguish those.`,
      tone: "medium",
      evidence: ["no edges in the persisted graph"],
    });
  }

  const sharedDbEdges = loaded.input.dependencies.filter((edge) => edge.type === "shared_db");
  if (sharedDbEdges.length > 0) {
    items.push({
      id: "architecture-shared-db",
      label: `${plural(sharedDbEdges.length, "edge")} through a shared database`,
      detail: `${sharedDbEdges.map((edge) => `${edge.fromService} → ${edge.toService}`).slice(0, 6).join(", ")} couple through storage rather than through a call, which couples their migration order too.`,
      tone: "medium",
      evidence: [],
    });
  }

  const unclassified = loaded.input.dependencies.filter((edge) => edge.type === "unknown");
  if (unclassified.length > 0) {
    items.push({
      id: "architecture-unclassified",
      label: `${plural(unclassified.length, "edge")} could not be classified`,
      detail: `${joinList(unclassified.map((edge) => `${edge.fromService} → ${edge.toService}`), 8)} were recorded without a relationship type. The coupling is real; the mechanism behind it is not known, so treat it as the conservative case.`,
      tone: "medium",
      evidence: [],
    });
  }

  const counts: ReportCount[] = [
    { label: "Graph nodes", value: String(graph.nodes.length) },
    { label: "Graph edges", value: String(graph.edges.length) },
    { label: "Edge types", value: graph.edgeTypes.length > 0 ? graph.edgeTypes.map(edgeLabelFor).join(", ") : "none recorded" },
    { label: "Cycles", value: String(graph.cycles.length) },
    { label: "Isolated services", value: String(graph.isolated.length) },
  ];

  return {
    id: "architecture",
    title: "Architecture Analysis",
    summary:
      graph.edges.length === 0
        ? "No dependency edges were recorded, so this section has no structure to describe."
        : `${plural(graph.nodes.length, "service")} are linked by ${plural(graph.edges.length, "recorded edge")}${graph.cycles.length > 0 ? `, including ${plural(graph.cycles.length, "circular chain")}` : " with no circular chains"}. The dependency graph below shows the same model.`,
    counts,
    items: capped(items),
    emptyNote:
      "No architecture output and no dependency edges were recorded for this run, so there is no structure to describe.",
    ask: {
      question: `Where is ${project.name} most tightly coupled, and what should be separated first?`,
      context: `Report · Architecture: ${plural(graph.nodes.length, "node")}, ${plural(graph.edges.length, "edge")}, ${plural(graph.cycles.length, "cycle")}`,
    },
  };
}

function riskSection(input: ReportInput): ReportSection {
  const { project, loaded } = input;
  const ranked = rankedSeverity(loaded);
  const byLevel = countBy(loaded.input.findings.map((finding) => finding.riskLevel));

  const items: ReportItem[] = ranked.map((finding) => ({
    id: `risk-${finding.key}`,
    label: `${finding.serviceName} — ${finding.riskLevel}`,
    detail:
      finding.reason ??
      finding.recommendation ??
      `Recorded at ${finding.riskLevel} risk by the Risk stage; no reasoning text was persisted for it.`,
    tone: finding.riskLevel as ReportTone,
    evidence: finding.evidence,
    ask: {
      question: `Why is ${finding.serviceName} rated ${finding.riskLevel}, and what evidence supports that rating?`,
      context: `Report · Risk finding: ${finding.serviceName} (${finding.riskLevel} risk)`,
    },
  }));

  const counts: ReportCount[] = [
    ...RISK_LEVELS.map((level) => ({
      label: `${level}`,
      value: String(byLevel[level] ?? 0),
    })),
    { label: "Findings", value: String(loaded.input.findings.length) },
  ];

  const criticalAndHigh = ranked.filter(
    (finding) => finding.riskLevel === "critical" || finding.riskLevel === "high",
  );

  return {
    id: "risk",
    title: "Risk Analysis",
    summary:
      loaded.input.findings.length === 0
        ? "No findings were persisted, so no service carries a risk rating."
        : `${plural(criticalAndHigh.length, "service")} are rated critical or high out of ${plural(loaded.input.findings.length, "finding")}. Risk levels map to ${RISK_LEVEL_VALUES.critical}/${RISK_LEVEL_VALUES.high}/${RISK_LEVEL_VALUES.medium}/${RISK_LEVEL_VALUES.low} in the rubric, and the headline Risk score is the ${loaded.scorecard.riskWeighting === "dependency" ? "dependency-weighted" : "equal-weighted"} mean of them.`,
    counts,
    items: capped(items),
    emptyNote: "No service findings were persisted for this run, so there is nothing to rate.",
    ask: {
      question: ranked[0]
        ? `Why is ${ranked[0].serviceName} rated ${ranked[0].riskLevel}, and what evidence supports that rating?`
        : `What risk findings were recorded for ${project.name}?`,
      context: `Report · Risk: ${plural(byLevel.critical ?? 0, "critical finding")}, ${plural(byLevel.high ?? 0, "high finding")}`,
    },
  };
}

/**
 * Findings, grouped by affected service — the view that does not require the graph.
 *
 * Risk analysis answers "how bad is this, worst first"; this answers "what is wrong
 * with *this* service", which is the question someone actually asks before touching
 * one. Every fact here is read from the persisted analysis: the finding row (severity,
 * the rubric's structured inputs, dependent count), the Discovery output's risk factors
 * and recommendation for that service, the Risk output's reasoning and evidence source,
 * and the graph model's edge counts for it.
 *
 * Nothing is inferred about services the analysis did not rate: a service that appears
 * only as an endpoint of an edge is listed as exactly that — unrated — rather than
 * being given the benefit of the doubt or quietly omitted.
 */
function serviceFindingsSection(input: ReportInput): ReportSection {
  const { project, loaded, graph } = input;
  const findings = loaded.input.findings;
  const { factors } = evidenceIndex(loaded);
  const ranked = rankedSeverity(loaded);

  const nodeByKey = new Map(graph.nodes.map((node) => [node.id, node]));
  const labelByKey = new Map(graph.nodes.map((node) => [node.id, node.label]));

  /** Which services a given service calls, and which call it — from the graph model. */
  const calls = new Map<string, { label: string; type: string }[]>();
  const calledBy = new Map<string, { label: string; type: string }[]>();
  for (const edge of graph.edges) {
    calls.set(edge.source, [
      ...(calls.get(edge.source) ?? []),
      { label: labelByKey.get(edge.target) ?? edge.target, type: edgeLabelFor(edge.type) },
    ]);
    calledBy.set(edge.target, [
      ...(calledBy.get(edge.target) ?? []),
      { label: labelByKey.get(edge.source) ?? edge.source, type: edgeLabelFor(edge.type) },
    ]);
  }

  const items: ReportItem[] = ranked.map((finding) => {
    const key = finding.key;
    const node = nodeByKey.get(key);
    const detail = factors.get(key);
    const outgoing = calls.get(key) ?? [];
    const incoming = calledBy.get(key) ?? [];

    const traits: string[] = [`${finding.riskLevel} risk`];
    if (finding.requiresMajorRestructuring) traits.push("needs major restructuring");
    if (finding.hasTestCoverageGap) traits.push("test-coverage gap");
    if (finding.dataQualityIssueCount > 0) traits.push(`${finding.dataQualityIssueCount} data-quality issue(s)`);
    traits.push(plural(finding.dependentCount, "dependent"));

    const evidence: string[] = [];
    if (detail?.recommendation) evidence.push(`Recommendation: ${detail.recommendation}`);
    evidence.push(...finding.evidence);
    if (outgoing.length > 0) {
      evidence.push(
        `Calls: ${outgoing.map((edge) => `${edge.label} (${edge.type})`).join(", ")}`,
      );
    }
    if (incoming.length > 0) {
      evidence.push(
        `Called by: ${incoming.map((edge) => `${edge.label} (${edge.type})`).join(", ")}`,
      );
    }
    if (node && node.incoming === 0 && node.outgoing === 0) {
      evidence.push("No recorded relationships — the analysis found no edge for it.");
    }

    return {
      id: `service-finding-${key}`,
      label: finding.serviceName,
      detail: traits.join(" · "),
      tone: finding.riskLevel as ReportTone,
      evidence,
      ask: {
        question: `What needs to happen to ${finding.serviceName}, and what depends on it?`,
        context: `Report · Service finding: ${finding.serviceName} (${finding.riskLevel} risk)`,
      },
    };
  });

  // Services that appear only in the topology. They have no finding because the
  // analysis never assessed them, which is a fact worth stating rather than a gap
  // worth hiding — and it is the only place outside the graph where they are visible.
  const unassessed = graph.nodes
    .filter((node) => node.unknownRisk)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map<ReportItem>((node) => ({
      id: `service-finding-unrated-${node.id}`,
      label: node.label,
      detail: "unrated — appears in a dependency edge but was not in the assessed inventory",
      tone: "neutral",
      evidence: [
        `${plural(node.incoming, "dependent")}, ${plural(node.outgoing, "dependency", "dependencies")} recorded`,
      ],
    }));

  const restructureCount = findings.filter((finding) => finding.requiresMajorRestructuring).length;
  const gapCount = findings.filter((finding) => finding.hasTestCoverageGap).length;
  const severeCount = findings.filter(
    (finding) => finding.riskLevel === "critical" || finding.riskLevel === "high",
  ).length;

  const counts: ReportCount[] = [
    { label: "Services with findings", value: String(findings.length) },
    { label: "Critical or high", value: String(severeCount) },
    { label: "Needs restructuring", value: String(restructureCount) },
    { label: "Coverage gaps", value: String(gapCount) },
    { label: "Unrated (edges only)", value: String(unassessed.length) },
  ];

  return {
    id: "service-findings",
    title: "Findings by Service",
    summary:
      findings.length === 0
        ? "No service findings were persisted for this run."
        : `Every one of the ${plural(findings.length, "service")} with a finding, grouped by service: severity, the rubric's inputs, what it depends on, and the evidence behind the rating.${unassessed.length > 0 ? ` ${plural(unassessed.length, "further service")} appear only in the dependency edges and are unrated.` : ""}`,
    counts,
    items: capped([...items, ...unassessed]),
    emptyNote:
      "No service findings were persisted for this run, so there is nothing to group by service.",
    ask: {
      question: `Walk me through the findings for ${project.name} service by service.`,
      context: `Report · Findings by service: ${plural(findings.length, "service with a finding")}, ${plural(unassessed.length, "unrated service")}`,
    },
  };
}

function migrationSection(input: ReportInput): ReportSection {
  const { project, loaded, graph } = input;
  const findings = loaded.input.findings;
  const architecture = loaded.outputs.architecture;

  const straightforward = findings.filter(
    (finding) => !finding.requiresMajorRestructuring && !finding.hasTestCoverageGap && finding.riskLevel !== "critical" && finding.riskLevel !== "high",
  );
  const restructuring = findings.filter((finding) => finding.requiresMajorRestructuring);
  const coverageGaps = findings.filter((finding) => finding.hasTestCoverageGap);

  // With no findings there is no area to describe: the section's empty note says so
  // rather than three items that each restate "none".
  const items: ReportItem[] =
    findings.length === 0
      ? []
      : [
          {
            id: "migration-straightforward",
            label: `Straightforward areas (${straightforward.length})`,
            detail:
              straightforward.length > 0
                ? `${joinList(straightforward.map((finding) => finding.serviceName), 12)} are rated medium or low with no restructuring requirement and no recorded test-coverage gap — the candidates to move first.`
                : "No service qualifies: every finding carries a restructuring requirement, a coverage gap, or a critical/high rating.",
            tone: "positive",
            evidence: [`${straightforward.length} of ${findings.length} findings`],
          },
          {
            id: "migration-restructuring",
            label: `Requires restructuring (${restructuring.length})`,
            detail:
              restructuring.length > 0
                ? `${joinList(restructuring.map((finding) => `${finding.serviceName} (${plural(finding.dependentCount, "dependent")})`), 10)} were recorded as needing major restructuring. These are the estimate's main drivers and the phases that need designing rather than sequencing.`
                : "No finding was recorded as needing major restructuring.",
            tone: restructuring.length > 0 ? "high" : "neutral",
            evidence: [`${restructuring.length} of ${findings.length} findings`],
          },
          {
            id: "migration-coverage",
            label: `Test-coverage gaps (${coverageGaps.length})`,
            detail:
              coverageGaps.length > 0
                ? `${joinList(coverageGaps.map((finding) => finding.serviceName), 10)} have no recorded test coverage, so a migration of those services has no regression net unless one is built first.`
                : "No finding was recorded with a test-coverage gap.",
            tone: coverageGaps.length > 0 ? "medium" : "neutral",
            evidence: [`${coverageGaps.length} of ${findings.length} findings`],
          },
        ];

  const mostDependedUpon = [...graph.nodes]
    .filter((node) => node.incoming > 1)
    .sort((a, b) => b.incoming - a.incoming || a.id.localeCompare(b.id))
    .slice(0, 3);

  for (const node of mostDependedUpon) {
    items.push({
      id: `migration-sequencing-${node.id}`,
      label: `Sequencing: ${node.label}`,
      detail: `${plural(node.incoming, "service")} depend on it directly, so it has to be migrated together with, or before, those services rather than alongside them.`,
      tone: "medium",
      evidence: [],
    });
  }

  if (architecture && architecture.phasedPlan.length > 0) {
    for (const phase of [...architecture.phasedPlan].sort((a, b) => a.phaseNumber - b.phaseNumber)) {
      items.push({
        id: `migration-phase-${phase.phaseNumber}`,
        label: `Phase ${phase.phaseNumber} · ${phase.title}`,
        detail: phase.rationale
          ? `${phase.rationale}${phase.servicesInvolved.length > 0 ? ` Services: ${joinList(phase.servicesInvolved, 10)}.` : ""}`
          : phase.servicesInvolved.length > 0
            ? `Services: ${joinList(phase.servicesInvolved, 10)}.`
            : "No rationale or service list was recorded for this phase.",
        tone: "neutral",
        evidence: [],
      });
    }
  }

  const counts: ReportCount[] = [
    { label: "Straightforward", value: `${straightforward.length} of ${findings.length}` },
    { label: "Needs restructuring", value: String(restructuring.length) },
    { label: "Coverage gaps", value: String(coverageGaps.length) },
    { label: "Planned phases", value: architecture ? String(architecture.phasedPlan.length) : "none recorded" },
  ];

  return {
    id: "migration",
    title: "Migration Considerations",
    summary:
      findings.length === 0
        ? "No findings were persisted, so there is nothing to sequence."
        : `${plural(straightforward.length, "service")} of ${findings.length} look straightforward, ${restructuring.length} need major restructuring, and ${architecture ? `${plural(architecture.phasedPlan.length, "phase")} were planned` : "no phased plan was recorded"}.`,
    counts,
    items: capped(items),
    emptyNote: "No findings were persisted for this run, so no migration areas can be identified.",
    ask: {
      question: `Which parts of ${project.name} can migrate first, and which need restructuring?`,
      context: `Report · Migration: ${plural(restructuring.length, "restructuring service")}, ${plural(coverageGaps.length, "coverage gap")}`,
    },
  };
}

function estimatesSection(input: ReportInput): ReportSection {
  const { project, loaded } = input;
  const { explanation, refinement, scorecard } = loaded;

  const items: ReportItem[] = [];

  /** The three derived estimates, each with the rubric's own contributors. */
  const estimateNames = SCORE_NAMES.filter(
    (name) => name === "effort" || name === "cost" || name === "time",
  );

  for (const name of estimateNames) {
    const score: ScoreExplanation = explanation.scores[name];
    const contributors = score.contributions
      .filter((contribution) => contribution.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 4)
      .map((contribution) => `${contribution.label}: ${contribution.value >= 0 ? "+" : ""}${contribution.value.toFixed(2)} — ${contribution.detail}`);

    items.push({
      id: `estimates-${name}`,
      label: `${score.label} — ${formatScoreValue(score)}`,
      detail: score.summary,
      tone: "neutral",
      evidence: [...contributors, ...score.factors.map((factor) => `${factor.label}: ${factor.value} — ${factor.note}`)].slice(0, 6),
    });
  }

  const time = explanation.scores.time;
  if (time.formatted !== formatScoreValue(time)) {
    items.push({
      id: "estimates-time-band",
      label: `Time band — ${time.formatted}`,
      detail: time.summary,
      tone: "neutral",
      evidence: time.factors.map((factor) => `${factor.label}: ${factor.value} — ${factor.note}`),
    });
  }

  items.push({
    id: "estimates-assumptions",
    label: `Assumptions in force (${scorecard.assumptions.teamSize} × ${scorecard.assumptions.currency} ${scorecard.assumptions.weeklyRate.toLocaleString("en-US")} per engineer-week)`,
    detail:
      "Team size and blended weekly rate are inputs, not findings — adjusting them in “Refine these estimates” recomputes cost and time without touching the analysis.",
    tone: "neutral",
    evidence: describeAssumptions(explanation.assumptions).map(
      (line) => `${line.label}: ${line.value} — ${line.note}`,
    ),
  });

  const operational: OperationalAdjustment = refinement.adjustment;
  const signals: OperationalSignals = refinement.operational;

  // Keyed off the operational adjustment itself, not off `refinement.changed`:
  // editing the team size or the weekly rate changes cost and time without any
  // operational data being involved, and a report that called that an operational
  // adjustment would be attributing the movement to the wrong input.
  if (refinement.changed && operational.applied) {
    items.push({
      id: "estimates-operational",
      label: `Operational data moved Risk ${operational.delta > 0 ? "+" : ""}${operational.delta} points`,
      detail: `${refinement.description} ${describeSignals(signals)}`,
      tone: operational.delta > 0 ? "medium" : "positive",
      evidence: [
        ...operational.terms.map((term) => `${term.label}: ${term.value >= 0 ? "+" : ""}${term.value} — ${term.detail}`),
        `bounded to ±${OPERATIONAL_RISK.maxAdjustment} points`,
        ...operational.reasons,
      ].slice(0, 10),
    });
  } else {
    items.push({
      id: "estimates-operational",
      label: "No operational data applied",
      detail:
        "These are code-only estimates: they rest on the structured findings alone. Attaching operational data (logs, health or incident files) adjusts Risk only, within a bounded range, and is recalculated without a model call.",
      tone: "neutral",
      evidence: [describeSignals(signals)],
    });
  }

  if (refinement.parameters.length > 0) {
    items.push({
      id: "estimates-parameters",
      label: "Migration parameters in force",
      detail: "Recorded business constraints. They are compared against the estimate rather than folded into it — a budget never lowers a cost estimate.",
      tone: "neutral",
      evidence: refinement.parameters.map(
        (assessment: ParameterAssessment) => `${assessment.label}: ${assessment.value} (${assessment.status}) — ${assessment.note}`,
      ),
    });
  }

  const counts: ReportCount[] = [
    ...estimateNames.map((name) => ({
      label: explanation.scores[name].label,
      value: formatScoreValue(explanation.scores[name]),
    })),
    { label: "Confidence", value: scorecard.confidence.label },
    { label: "Evidence quality", value: explanation.evidence.level },
  ];

  return {
    id: "estimates",
    title: "Effort and Cost Explanation",
    summary: `${formatScoreValue(explanation.scores.effort)} effort over ${formatScoreValue(explanation.scores.time)} (${explanation.scores.time.formatted}), estimated at ${formatScoreValue(explanation.scores.cost)}. Every figure is arithmetic over the persisted findings — no model produced a number.`,
    counts,
    items: capped(items),
    emptyNote: "No scorecard was available, so the estimates cannot be explained.",
    ask: {
      question: `Why does ${project.name} come out at ${formatScoreValue(explanation.scores.cost)} and ${explanation.scores.time.formatted}, and what drives the estimate?`,
      context: `Report · Estimates: effort ${formatScoreValue(explanation.scores.effort)}, risk weighting ${scorecard.riskWeighting}`,
    },
  };
}

function evidenceSection(input: ReportInput): ReportSection {
  const { project, loaded, sources } = input;
  const { explanation, outputs } = loaded;

  const items: ReportItem[] = [];

  items.push({
    id: "evidence-quality",
    label: `Evidence quality: ${explanation.evidence.label}`,
    detail: "How much of the assessment rests on observable code and operational signals rather than on inference.",
    tone: explanation.evidence.level === "strong" ? "positive" : "medium",
    evidence: explanation.evidence.reasons,
  });

  for (const source of sources.sources) {
    items.push({
      id: `evidence-source-${source.source}`,
      label: source.source,
      detail: `${source.documentType} · ${plural(source.chunks, "chunk")} indexed`,
      tone: "neutral",
      evidence: [],
    });
  }

  const citedFindings = rankedSeverity(loaded).filter((finding) => finding.evidence.length > 0);
  for (const finding of citedFindings.slice(0, 12)) {
    items.push({
      id: `evidence-finding-${finding.key}`,
      label: `Rating evidence: ${finding.serviceName}`,
      detail: `The ${finding.riskLevel} rating for ${finding.serviceName} rests on the facts below.`,
      tone: finding.riskLevel as ReportTone,
      evidence: finding.evidence,
    });
  }

  // Edge evidence comes from the validated Discovery output rather than the
  // persisted row: the persisted edge is what the rubric reads (and carries no
  // evidence text by design), while the extraction's own evidence string is the
  // static-analysis fact behind the relationship.
  const { edgeEvidence } = evidenceIndex(loaded);
  const edgesWithEvidence = loaded.input.dependencies.filter((edge) =>
    edgeEvidence.has(edgeEvidenceKey(edge.fromService, edge.toService)),
  );

  for (const edge of edgesWithEvidence.slice(0, 12)) {
    items.push({
      id: `evidence-edge-${edge.fromService}-${edge.toService}`,
      label: `${edge.fromService} → ${edge.toService}`,
      detail: `${edgeLabelFor(edge.type)} — ${edgeEvidence.get(edgeEvidenceKey(edge.fromService, edge.toService))}`,
      tone: "neutral",
      evidence: [],
    });
  }

  const comparison = outputs.comparison;
  if (comparison) {
    items.push({
      id: "evidence-comparison",
      label: "Comparison self-assessment",
      detail: comparison.accuracyAssessment,
      tone: "neutral",
      evidence: [
        `matched: ${comparison.matched.length}`,
        `missed: ${comparison.missed.length}`,
        `incorrect: ${comparison.incorrect.length}`,
        ...comparison.missed.slice(0, 5).map((entry) => `missed: ${entry}`),
        ...comparison.incorrect.slice(0, 5).map((entry) => `incorrect: ${entry}`),
      ],
    });
  }

  const counts: ReportCount[] = [
    { label: "Indexed files", value: String(project.fileCount) },
    { label: "Chunks", value: String(project.chunkCount) },
    {
      label: "Source files listed",
      value:
        sources.total > sources.sources.length
          ? `${sources.sources.length} of ${sources.total}`
          : String(sources.total),
    },
    { label: "Findings", value: String(loaded.input.findings.length) },
    { label: "Edges with evidence", value: String(edgesWithEvidence.length) },
  ];

  const notes = elisionNote(sources.total, sources.sources.length);

  return {
    id: "evidence",
    title: "Evidence",
    summary: `${plural(sources.total, "indexed source file")} and ${plural(project.chunkCount, "indexed chunk")} back this assessment, alongside ${plural(edgesWithEvidence.length, "dependency edge")} that carry static-analysis evidence.${notes.length > 0 ? ` (${notes[0]})` : ""}`,
    counts,
    items: capped(items),
    emptyNote:
      "No indexed sources, findings or cited edges were recorded for this run, so there is no evidence to list.",
    ask: {
      question: `What evidence was used to assess ${project.name}, and what is missing?`,
      context: `Report · Evidence: ${plural(sources.total, "indexed source file")}, ${explanation.evidence.level} evidence quality`,
    },
  };
}

// ─── Critical path ──────────────────────────────────────────────────────────

/**
 * The longest chain of dependencies in the graph.
 *
 * A longest path over the normalized edges the graph already holds, not a second
 * layout: `buildDependencyGraph()` normalizes the edges, and this walks them.
 *
 * It deliberately does **not** use the model's `depth` field, even though that is
 * also a longest-path measure. Nodes left unplaced by the layering — everything in
 * a cycle — all share one synthetic deepest layer, so a depth walk from them stops
 * immediately and reports a one-node "chain" for a graph whose real chain runs
 * through them. Walking the edges gives the same answer as the layering on an
 * acyclic graph and a useful one when a cycle is present.
 *
 * Deterministic: ties break on node id, and a node cannot appear twice (a chain
 * that revisited a node would not be a path).
 */
export function longestChain(
  graph: DependencyGraphModel,
  label: (id: string) => string,
): string[] {
  if (graph.nodes.length === 0) return [];

  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.target, outgoing.get(edge.target) ?? []);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target].sort());
  }

  const memo = new Map<string, string[]>();
  const onPath = new Set<string>();

  const chainFrom = (id: string): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    // A node already on the current walk is where this branch stops: following it
    // would be following the cycle, and the chain is reported as the path taken.
    if (onPath.has(id)) return [id];

    onPath.add(id);
    let best: string[] = [id];

    for (const next of outgoing.get(id) ?? []) {
      const candidate: string[] = [id];
      for (const node of chainFrom(next)) {
        if (candidate.includes(node)) break;
        candidate.push(node);
      }
      if (candidate.length > best.length) best = candidate;
    }

    onPath.delete(id);
    memo.set(id, best);
    return best;
  };

  let longest: string[] = [];
  for (const id of [...graph.nodes.map((node) => node.id)].sort()) {
    const candidate = chainFrom(id);
    if (candidate.length > longest.length) longest = candidate;
  }

  return longest.map(label);
}

// ─── Assembly ───────────────────────────────────────────────────────────────

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function executiveSummarySection(input: ReportInput, highlights: ReportItem[], paragraphs: string[]): ReportSection {
  const { project, loaded } = input;
  const { scorecard, explanation } = loaded;

  return {
    id: "executive-summary",
    title: "Executive Summary",
    summary: paragraphs[0] ?? "",
    counts: SCORE_NAMES.map((name) => ({
      label: explanation.scores[name].label,
      value: formatScoreValue(explanation.scores[name]),
    })),
    items: highlights,
    emptyNote: "No analysis output was recorded, so there is no summary to give.",
    ask: {
      question: `Summarise the migration posture of ${project.name} and its biggest risks.`,
      context: `Report · Executive summary: readiness ${formatScoreValue(explanation.scores.readiness)}, risk ${formatScoreValue(explanation.scores.risk)}, ${scorecard.confidence.label}`,
    },
  };
}

function askFor(section: ReportSection): ReportAsk {
  return section.ask;
}

/**
 * The report, composed from the persisted analysis.
 *
 * Section order is fixed (see `REPORT_SECTION_IDS`) so the report reads the same
 * way every time; only the contents vary with the analysis.
 */
export function buildAnalysisReport(input: ReportInput): AnalysisReport {
  const { project, loaded } = input;

  const hasStructuredOutput = Object.values(loaded.outputs).some((output) => output !== undefined);
  const empty =
    !hasStructuredOutput &&
    loaded.input.findings.length === 0 &&
    loaded.input.dependencies.length === 0;

  const highlights = executiveSummaryHighlights(input);
  const paragraphs = executiveSummaryParagraphs(input);

  const sections: ReportSection[] = [
    executiveSummarySection(input, highlights, paragraphs),
    discoverySection(input),
    architectureSection(input),
    riskSection(input),
    serviceFindingsSection(input),
    migrationSection(input),
    estimatesSection(input),
    evidenceSection(input),
  ].map((section) => ({ ...section, ask: askFor(section) }));

  return {
    projectId: project.id,
    runId: loaded.run.id,
    empty,
    emptyReason:
      "This run recorded no structured analysis output and no findings — it predates the structured columns or produced nothing to report. Re-running the analysis produces one.",
    summaryParagraphs: paragraphs,
    highlights,
    sections,
  };
}
