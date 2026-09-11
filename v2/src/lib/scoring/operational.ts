import {
  OPERATIONAL_KINDS,
  OPERATIONAL_RISK,
  clamp,
  round,
  type OperationalKind,
} from "./assumptions";

/**
 * Operational data: what it is, whether it is usable, and what it does to Risk.
 *
 * This module is pure — no database, no model, no network, no clock. Three jobs,
 * deliberately separated so each is testable on its own:
 *
 * 1. **Parse and validate** the files a user attaches (logs, health/traffic JSON,
 *    incident reports). Every rejection carries a sentence naming the file and
 *    what was wrong with it, because "invalid input" is not something a person can
 *    act on.
 * 2. **Reduce** the validated entries to a small set of measured signals
 *    (`OperationalSignals`). Nothing downstream sees raw text, so a score cannot
 *    depend on how a log happened to be worded.
 * 3. **Adjust** Risk bidirectionally, in bounded threshold bands.
 *
 * The adjustment is Risk-only by design. Operational data sharpens risk because
 * risk is about *behaviour in production*; effort and duration are properties of
 * the code and the plan, and letting a noisy metric move the timeline would
 * present a measurement as a plan.
 */

export type OperationalEntry = {
  kind: OperationalKind;
  /** The file name the entry came from, shown back to the user. */
  source: string;
  /** Service the entry describes, when the file says so. */
  serviceName: string | null;
  /** Raw text, for logs and incident reports. */
  content: string | null;
  /** Parsed JSON payload, for health/traffic/db-stats files. */
  payload: Record<string, unknown> | null;
};

export type OperationalFile = { name: string; text: string };

export type ParsedOperationalFile =
  | { ok: true; entry: OperationalEntry }
  | { ok: false; source: string; error: string };

const JSON_KINDS: OperationalKind[] = ["health", "traffic", "db_stats"];
const TEXT_KINDS: OperationalKind[] = ["log", "incident"];

/** Keys that identify a service in a payload, in the order they are consulted. */
const SERVICE_KEYS = ["service", "serviceName", "component", "name", "system"] as const;

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function serviceNameFrom(payload: Record<string, unknown>): string | null {
  for (const key of SERVICE_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** The declared service name of a stored payload, for callers reading rows back. */
export function serviceNameFromPayload(payload: Record<string, unknown> | null): string | null {
  return payload === null ? null : serviceNameFrom(payload);
}

/**
 * The kind a file appears to be, from its name. Returns null when the extension
 * is one this feature does not accept, so the caller can say so.
 */
export function detectKind(file: OperationalFile): OperationalKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return null; // decided by content, see below
  if (name.endsWith(".log") || name.includes("log")) return "log";
  if (name.endsWith(".md") || name.endsWith(".txt") || name.includes("incident")) return "incident";
  return null;
}

/** True when a JSON payload looks like the given kind, judged by its own keys. */
export function payloadKind(payload: Record<string, unknown>): OperationalKind {
  const keys = Object.keys(payload).map((key) => key.toLowerCase());
  const has = (candidate: string) => keys.some((key) => key.includes(candidate));

  // Incident first, because an incident report is the most specific shape and also the
  // one whose keys overlap the others least: a payload carrying `incidents` (or a
  // severity, or a postmortem) is an incident report whatever else it mentions.
  if (has("incident") || has("outage") || has("postmortem") || has("severity")) return "incident";
  if (has("uptime") || has("availability") || has("status") || has("health")) return "health";
  if (has("request") || has("rps") || has("traffic") || has("latency") || has("throughput")) {
    return "traffic";
  }
  if (has("table") || has("row") || has("databasesize") || has("dbsize") || has("schema")) {
    return "db_stats";
  }
  // No recognisable marker. Classified as health rather than rejected: a payload of
  // numbers attached as operational data is still evidence, and the signal
  // derivation only reads the keys it knows.
  return "health";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parses and validates one attached file.
 *
 * `forcedKind` lets the upload UI say what a file is when the name is ambiguous;
 * without it a `.json` file is classified by its contents.
 */
export function parseOperationalFile(
  file: OperationalFile,
  forcedKind?: OperationalKind,
): ParsedOperationalFile {
  const source = file.name;
  const text = file.text;

  if (text.trim().length === 0) {
    return { ok: false, source, error: `${source} is empty, so it carries no signal.` };
  }

  if (forcedKind !== undefined) {
    return finishParsed(source, text, forcedKind);
  }

  const byName = detectKind(file);
  if (byName !== null) return finishParsed(source, text, byName);

  if (source.toLowerCase().endsWith(".json")) {
    const payload = tryParseJson(text);
    if (payload === null) {
      return {
        ok: false,
        source,
        error: `${source} is named .json but could not be parsed as JSON. Fix the file or rename it to .log/.txt.`,
      };
    }
    return { ok: true, entry: { kind: payloadKind(payload), source, serviceName: serviceNameFrom(payload), content: null, payload } };
  }

  return {
    ok: false,
    source,
    error: `${source} has an unsupported extension. Accepted: .log (logs), .json (health/traffic), .md or .txt (incident reports).`,
  };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (record !== null) return record;
    // A top-level array is accepted when it is an array of records: that is the
    // shape a metrics export usually has, and rejecting it would reject the most
    // common real input.
    if (Array.isArray(parsed) && parsed.length > 0 && asRecord(parsed[0]) !== null) {
      return { entries: parsed };
    }
    return null;
  } catch {
    return null;
  }
}

function finishParsed(source: string, text: string, kind: OperationalKind): ParsedOperationalFile {
  if (JSON_KINDS.includes(kind)) {
    const payload = tryParseJson(text);
    if (payload === null) {
      return {
        ok: false,
        source,
        error: `${source} was read as ${kind} data, which must be a JSON object. It could not be parsed.`,
      };
    }
    return { ok: true, entry: { kind, source, serviceName: serviceNameFrom(payload), content: null, payload } };
  }

  if (TEXT_KINDS.includes(kind)) {
    return { ok: true, entry: { kind, source, serviceName: null, content: text, payload: null } };
  }

  return {
    ok: false,
    source,
    error: `${source} could not be read as operational data of any supported kind.`,
  };
}

export type OperationalParseResult = {
  entries: OperationalEntry[];
  errors: { source: string; error: string }[];
};

/**
 * Parses a batch. A rejected file never discards the accepted ones — the user's
 * other evidence is still usable, and the rejection is reported per file.
 */
export function parseOperationalFiles(files: OperationalFile[]): OperationalParseResult {
  const entries: OperationalEntry[] = [];
  const errors: { source: string; error: string }[] = [];

  for (const file of files) {
    const parsed = parseOperationalFile(file);
    if (parsed.ok) entries.push(parsed.entry);
    else errors.push({ source: parsed.source, error: parsed.error });
  }

  return { entries, errors };
}

export type OperationalSignals = {
  entries: number;
  kinds: Record<OperationalKind, number>;
  /** Normalized service names with any operational data at all. */
  services: string[];
  servicesWithHealth: string[];
  servicesWithTraffic: string[];
  servicesWithIncidents: string[];
  /** Mean of the per-service error rates that were reported. */
  meanErrorRatePercent: number | null;
  /** How many measurements the mean was taken over — reported in the reason text. */
  errorRateSamples: number;
  /** The lowest availability reported — the number a user would feel. */
  worstUptimePercent: number | null;
  incidentCount: number;
  criticalIncidentCount: number;
  restartCount: number;
  errorLogLines: number;
  totalLogLines: number;
  /** Error lines ÷ non-empty lines, over every log supplied. */
  errorLogDensity: number | null;
  databaseSizeMb: number | null;
  /** True when at least one usable signal was derived. */
  available: boolean;
};

const ERROR_LOG_PATTERN = /\b(error|fatal|severe|exception|panic)\b/i;
const CRITICAL_PATTERN = /\b(critical|sev[-\s]?1|p1|outage)\b/i;
const INCIDENT_PATTERN = /\b(incident|outage|sev[-\s]?[1-4]|p[1-4]|failure)\b/i;

/** Reads the first present key holding a finite number (or numeric string). */
export function numberFrom(payload: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Every record in a payload: the payload itself, or the entries of a top-level array. */
function payloadRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const nested = payload.entries;
  if (Array.isArray(nested)) {
    return nested.map(asRecord).filter((record): record is Record<string, unknown> => record !== null);
  }
  return [payload];
}

const ERROR_RATE_KEYS = ["errorRatePercent", "errorRate", "error_rate_percent", "error_rate", "errorPercentage"];
const UPTIME_KEYS = ["uptimePercent", "uptime", "availabilityPercent", "availability", "availability_percent"];
const RESTART_KEYS = ["restartCount", "restarts", "restart_count"];
const DB_SIZE_KEYS = ["databaseSizeMb", "databaseSize", "dbSizeMb", "sizeMb", "storageMb"];

function countIncidentArray(value: unknown): { total: number; critical: number } | null {
  if (!Array.isArray(value)) return null;
  let critical = 0;
  for (const item of value) {
    const record = asRecord(item);
    if (record === null) continue;
    const severity = record.severity ?? record.level ?? record.priority;
    if (typeof severity === "string" && CRITICAL_PATTERN.test(severity)) critical += 1;
  }
  return { total: value.length, critical };
}

/**
 * Reduces validated entries to measured signals.
 *
 * Deterministic over the entry set: an entry list in a different order produces
 * the same signals, because every aggregate here is a mean, a minimum, or a count.
 */
export function deriveOperationalSignals(entries: OperationalEntry[]): OperationalSignals {
  const kinds: Record<OperationalKind, number> = { log: 0, health: 0, traffic: 0, incident: 0, db_stats: 0 };
  const services = new Set<string>();
  const healthServices = new Set<string>();
  const trafficServices = new Set<string>();
  const incidentServices = new Set<string>();

  const errorRates: number[] = [];
  const uptimes: number[] = [];

  let incidentCount = 0;
  let criticalIncidentCount = 0;
  let restartCount = 0;
  let errorLogLines = 0;
  let totalLogLines = 0;
  let databaseSizeMb: number | null = null;
  let incidentDataPresent = false;

  for (const entry of entries) {
    kinds[entry.kind] += 1;
    const serviceKey = entry.serviceName ? normalize(entry.serviceName) : null;
    if (serviceKey) services.add(serviceKey);

    if (entry.kind === "health" || entry.kind === "traffic" || entry.kind === "db_stats") {
      if (entry.kind !== "db_stats" && serviceKey) {
        if (entry.kind === "health") healthServices.add(serviceKey);
        else trafficServices.add(serviceKey);
      }

      for (const record of payloadRecords(entry.payload ?? {})) {
        const errorRate = numberFrom(record, ERROR_RATE_KEYS);
        if (errorRate !== null) errorRates.push(errorRate);

        const uptime = numberFrom(record, UPTIME_KEYS);
        if (uptime !== null) uptimes.push(uptime);

        const restarts = numberFrom(record, RESTART_KEYS);
        if (restarts !== null && restarts > 0) restartCount += Math.round(restarts);

        const size = numberFrom(record, DB_SIZE_KEYS);
        if (size !== null) databaseSizeMb = Math.max(databaseSizeMb ?? 0, size);
      }
    }

    if (entry.kind === "incident") {
      incidentDataPresent = true;
      if (serviceKey) incidentServices.add(serviceKey);

      const declared = countIncidentArray(entry.payload?.incidents) ?? countIncidentArray(entry.payload?.entries);
      if (declared !== null) {
        incidentCount += declared.total;
        criticalIncidentCount += declared.critical;
      } else {
        const declaredTotal = numberFrom(entry.payload ?? {}, ["count", "incidentCount", "total"]);
        if (declaredTotal !== null) incidentCount += Math.max(0, Math.round(declaredTotal));

        const declaredCritical = numberFrom(entry.payload ?? {}, ["criticalCount", "critical"]);
        if (declaredCritical !== null) criticalIncidentCount += Math.max(0, Math.round(declaredCritical));
      }

      const text =
        entry.content ??
        [entry.payload?.summary, entry.payload?.description, entry.payload?.severity]
          .filter((value): value is string => typeof value === "string")
          .join(" ");

      if (declared === null && entry.content !== null) {
        // Free-text incident report: counted by declared severity keywords, which is
        // the only thing a keyword scan can honestly claim. The detail string in the
        // adjustment says so rather than implying a structured count.
        for (const line of entry.content.split(/\r?\n/)) {
          if (!INCIDENT_PATTERN.test(line)) continue;
          incidentCount += 1;
          if (CRITICAL_PATTERN.test(line)) criticalIncidentCount += 1;
        }
      } else if (declared === null && text.trim().length > 0) {
        incidentCount += 1;
        if (CRITICAL_PATTERN.test(text)) criticalIncidentCount += 1;
      }
    }

    if (entry.kind === "log" && entry.content !== null) {
      for (const line of entry.content.split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        totalLogLines += 1;
        if (ERROR_LOG_PATTERN.test(line)) errorLogLines += 1;
      }
    }
  }

  const meanErrorRatePercent =
    errorRates.length > 0 ? round(errorRates.reduce((sum, value) => sum + value, 0) / errorRates.length, 3) : null;
  const worstUptimePercent = uptimes.length > 0 ? round(Math.min(...uptimes), 3) : null;
  const errorLogDensity = totalLogLines > 0 ? round(errorLogLines / totalLogLines, 4) : null;

  return {
    entries: entries.length,
    kinds,
    services: [...services].sort(),
    servicesWithHealth: [...healthServices].sort(),
    servicesWithTraffic: [...trafficServices].sort(),
    servicesWithIncidents: [...incidentServices].sort(),
    meanErrorRatePercent,
    errorRateSamples: errorRates.length,
    worstUptimePercent,
    incidentCount,
    criticalIncidentCount,
    restartCount,
    errorLogLines,
    totalLogLines,
    errorLogDensity,
    databaseSizeMb,
    available:
      entries.length > 0 &&
      (meanErrorRatePercent !== null ||
        worstUptimePercent !== null ||
        incidentDataPresent ||
        errorLogDensity !== null),
  };
}

export type OperationalTerm = {
  key: string;
  label: string;
  /** Signed Risk points. */
  value: number;
  detail: string;
};

export type OperationalAdjustment = {
  /** True when at least one term moved Risk. */
  applied: boolean;
  /** Signed adjustment applied to the code-only Risk, clamped to ±`maxAdjustment`. */
  delta: number;
  /** The raw sum before clamping, kept so a bounded adjustment is visible as one. */
  unbounded: number;
  bounded: boolean;
  terms: OperationalTerm[];
  /** Human-readable reasons, one per contributing term plus a coverage note. */
  reasons: string[];
  signals: OperationalSignals;
};

/** Empty adjustment — the code-only baseline, used when there is no operational data. */
export function emptyOperationalAdjustment(signals: OperationalSignals): OperationalAdjustment {
  return {
    applied: false,
    delta: 0,
    unbounded: 0,
    bounded: false,
    terms: [],
    reasons: [],
    signals,
  };
}

/**
 * The signal set for "nothing was supplied".
 *
 * Exists so the code-only path and the refined path are the same code path: the
 * rubric never branches on whether operational data exists, it applies an
 * adjustment that happens to be zero. That is what makes "empty operational data
 * preserves the baseline" a structural property rather than a special case.
 */
export function emptyOperationalSignals(): OperationalSignals {
  return deriveOperationalSignals([]);
}

/**
 * Turns signals into bounded Risk points.
 *
 * Direction is decided by thresholds, not by sign conventions: a healthy error
 * rate contributes a credit (negative), an unhealthy one a penalty (positive), and
 * the same holds for availability and incident history. Credits and penalties can
 * coexist — a service with excellent uptime and a history of critical incidents is
 * exactly the case both signals exist to describe.
 */
export function computeOperationalAdjustment(signals: OperationalSignals): OperationalAdjustment {
  if (!signals.available) {
    // Nothing moves Risk, but a supplied file whose numbers are recorded verbatim is
    // still reported: "your data volume was noted and does not affect the score" is a
    // better answer than silence about a file the user just uploaded.
    return { ...emptyOperationalAdjustment(signals), reasons: informationalReasons(signals) };
  }

  const terms: OperationalTerm[] = [];
  const { errorRate, uptime, incidents, logs } = OPERATIONAL_RISK;

  const measured = signals.meanErrorRatePercent;
  if (measured !== null) {
    if (measured <= errorRate.healthyPercent) {
      const credit = -errorRate.maxCredit * (1 - measured / errorRate.healthyPercent);
      terms.push({
        key: "errorRate",
        label: "Measured error rate",
        value: round(credit, 2),
        detail:
          `mean ${measured}% over ${signals.errorRateSamples} measurement(s), at or below the ` +
          `${errorRate.healthyPercent}% healthy threshold — credit of up to ${errorRate.maxCredit} points`,
      });
    } else {
      const ratio = clamp(
        (measured - errorRate.healthyPercent) / (errorRate.criticalPercent - errorRate.healthyPercent),
        0,
        1,
      );
      terms.push({
        key: "errorRate",
        label: "Measured error rate",
        value: round(errorRate.maxPenalty * ratio, 2),
        detail:
          `mean ${measured}% against a healthy threshold of ${errorRate.healthyPercent}% and a critical ` +
          `threshold of ${errorRate.criticalPercent}%`,
      });
    }
  }

  const worstUptime = signals.worstUptimePercent;
  if (worstUptime !== null) {
    if (worstUptime >= uptime.healthyPercent) {
      const ratio = clamp((worstUptime - uptime.healthyPercent) / (100 - uptime.healthyPercent), 0, 1);
      terms.push({
        key: "uptime",
        label: "Measured availability",
        value: round(-uptime.maxCredit * ratio, 2),
        detail: `worst service at ${worstUptime}%, at or above the ${uptime.healthyPercent}% healthy threshold`,
      });
    } else {
      const ratio = clamp((uptime.healthyPercent - worstUptime) / (uptime.healthyPercent - uptime.poorPercent), 0, 1);
      terms.push({
        key: "uptime",
        label: "Measured availability",
        value: round(uptime.maxPenalty * ratio, 2),
        detail:
          `worst service at ${worstUptime}%, below the ${uptime.healthyPercent}% healthy threshold ` +
          `(full penalty at ${uptime.poorPercent}%)`,
      });
    }
  }

  if (signals.criticalIncidentCount > 0) {
    const value = Math.min(signals.criticalIncidentCount * incidents.perCritical, incidents.maxCriticalPenalty);
    terms.push({
      key: "criticalIncidents",
      label: "Critical incidents",
      value,
      detail: `${signals.criticalIncidentCount} critical-severity incident(s) at ${incidents.perCritical} points each, capped at ${incidents.maxCriticalPenalty}`,
    });
  }

  const nonCritical = Math.max(0, signals.incidentCount - signals.criticalIncidentCount);
  if (nonCritical > 0) {
    const value = Math.min(nonCritical * incidents.perIncident, incidents.maxIncidentPenalty);
    terms.push({
      key: "incidentVolume",
      label: "Incident volume",
      value,
      detail: `${nonCritical} non-critical incident(s), capped at ${incidents.maxIncidentPenalty} points`,
    });
  }

  if (signals.incidentCount === 0 && signals.servicesWithIncidents.length > 0) {
    terms.push({
      key: "incidentHistory",
      label: "Clean incident history",
      value: -incidents.maxCredit,
      detail: `incident data was supplied for ${signals.servicesWithIncidents.length} service(s) and reports none`,
    });
  }

  if (signals.errorLogDensity !== null && signals.errorLogDensity > 0) {
    const ratio = clamp(signals.errorLogDensity / logs.saturatedErrorDensity, 0, 1);
    terms.push({
      key: "logDensity",
      label: "Error density in logs",
      value: round(logs.maxPenalty * ratio, 2),
      detail: `${signals.errorLogLines} error line(s) in ${signals.totalLogLines} non-empty line(s) (${round(signals.errorLogDensity * 100, 2)}%), full penalty at ${round(logs.saturatedErrorDensity * 100, 0)}%`,
    });
  }

  const unbounded = round(
    terms.reduce((sum, term) => sum + term.value, 0),
    2,
  );
  const delta = clamp(unbounded, -OPERATIONAL_RISK.maxAdjustment, OPERATIONAL_RISK.maxAdjustment);
  const bounded = Math.abs(delta - unbounded) > 0.005;

  const reasons = terms.map(
    (term) =>
      `${term.label}: ${term.value > 0 ? "+" : ""}${term.value} Risk — ${term.detail}.`,
  );

  if (bounded) {
    reasons.push(
      `The measured signals summed to ${unbounded > 0 ? "+" : ""}${unbounded} but the adjustment is bounded to ±${OPERATIONAL_RISK.maxAdjustment} points.`,
    );
  }

  reasons.push(...informationalReasons(signals));

  return {
    applied: terms.length > 0,
    delta,
    unbounded,
    bounded,
    terms,
    reasons,
    signals,
  };
}

/**
 * Signals that are reported but never scored.
 *
 * Restart counts vary by deployment model and data volume has no defensible
 * threshold in the rubric, so both are stated verbatim next to the adjustment
 * rather than turned into points. A reader who cares about them can see them; the
 * score does not move on a number nobody can argue for.
 */
function informationalReasons(signals: OperationalSignals): string[] {
  const reasons: string[] = [];

  if (signals.restartCount > 0) {
    reasons.push(`${signals.restartCount} restart(s) were reported; restarts are reported but do not move Risk.`);
  }
  if (signals.databaseSizeMb !== null) {
    reasons.push(
      `${signals.databaseSizeMb} MB of database data was reported; data volume is recorded but does not move Risk.`,
    );
  }

  return reasons;
}

/** One-line summary of the signals, for the scorecard's evidence list. */
export function describeSignals(signals: OperationalSignals): string {
  if (!signals.available) return "No operational data was supplied for this project.";

  const parts: string[] = [`${signals.entries} operational data file(s)`];
  if (signals.services.length > 0) parts.push(`${signals.services.length} service(s) covered`);
  if (signals.meanErrorRatePercent !== null) parts.push(`mean error rate ${signals.meanErrorRatePercent}%`);
  if (signals.worstUptimePercent !== null) parts.push(`worst availability ${signals.worstUptimePercent}%`);
  if (signals.kinds.incident > 0) {
    parts.push(`${signals.incidentCount} incident(s) recorded, ${signals.criticalIncidentCount} critical`);
  }
  if (signals.totalLogLines > 0) parts.push(`${signals.errorLogLines}/${signals.totalLogLines} log lines at error level`);
  return parts.join(" · ");
}

export { OPERATIONAL_KINDS };
