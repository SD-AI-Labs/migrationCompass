import { describe, expect, it } from "vitest";

import { OPERATIONAL_RISK } from "./assumptions";
import {
  computeOperationalAdjustment,
  deriveOperationalSignals,
  describeSignals,
  emptyOperationalSignals,
  numberFrom,
  parseOperationalFile,
  parseOperationalFiles,
  payloadKind,
  type OperationalEntry,
} from "./operational";

/**
 * Operational data is the one input to the scorecard that arrives as a *file*
 * rather than as structured output the pipeline produced, so the tests here are
 * about three failure modes that would each corrupt a score silently:
 *
 * 1. a malformed file being accepted (and its garbage becoming a number),
 * 2. a rejection discarding the user's other evidence,
 * 3. an adjustment that is unbounded, or one-directional when the plan requires it
 *    to move Risk both up and down.
 */

const entry = (overrides: Partial<OperationalEntry> = {}): OperationalEntry => ({
  kind: "health",
  source: "health.json",
  serviceName: "order-service",
  content: null,
  payload: {},
  ...overrides,
});

describe("parsing operational files", () => {
  it("rejects an empty file with a sentence naming it", () => {
    const parsed = parseOperationalFile({ name: "health.json", text: "   \n " });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected rejection");
    expect(parsed.error).toContain("health.json");
    expect(parsed.error).toContain("empty");
  });

  it("rejects a .json file that is not JSON, and says what to do about it", () => {
    const parsed = parseOperationalFile({ name: "traffic.json", text: "{ not json" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected rejection");
    expect(parsed.error).toMatch(/\.json/);
    expect(parsed.error).toMatch(/\.log|rename/i);
  });

  it("rejects an unsupported extension and lists the accepted ones", () => {
    const parsed = parseOperationalFile({ name: "metrics.parquet", text: "binary-ish" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected rejection");
    expect(parsed.error).toContain(".log");
    expect(parsed.error).toContain(".json");
    expect(parsed.error).toContain(".txt");
  });

  it("classifies a JSON payload by its own keys rather than its name", () => {
    expect(payloadKind({ uptimePercent: 99.9 })).toBe("health");
    expect(payloadKind({ requestsPerMinute: 1200 })).toBe("traffic");
    expect(payloadKind({ databaseSizeMb: 4096 })).toBe("db_stats");
  });

  it("parses a health payload and keeps the declared service name", () => {
    const parsed = parseOperationalFile({
      name: "health.json",
      text: JSON.stringify({ service: "Order-service", uptimePercent: 99.95, errorRatePercent: 0.2 }),
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected acceptance");
    expect(parsed.entry.kind).toBe("health");
    expect(parsed.entry.serviceName).toBe("Order-service");
    expect(parsed.entry.payload?.uptimePercent).toBe(99.95);
  });

  it("accepts a top-level array of records, which is how metrics exports arrive", () => {
    const parsed = parseOperationalFile({
      name: "export.json",
      text: JSON.stringify([{ service: "a", errorRatePercent: 2 }, { service: "b", errorRatePercent: 4 }]),
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected acceptance");
    const signals = deriveOperationalSignals([parsed.entry]);

    // Both records are read, so the mean is over the whole export rather than its
    // first element — the failure mode a naive parser would have.
    expect(signals.meanErrorRatePercent).toBe(3);
  });

  it("reads logs and incident reports as text", () => {
    const log = parseOperationalFile({ name: "app.log", text: "INFO ok\nERROR boom\n" });
    const incident = parseOperationalFile({ name: "incidents-q3.txt", text: "CRITICAL: checkout outage" });

    expect(log.ok && log.entry.kind).toBe("log");
    expect(log.ok && log.entry.content).toContain("ERROR boom");
    expect(incident.ok && incident.entry.kind).toBe("incident");
  });

  it("keeps the files it can read when another is rejected", () => {
    const result = parseOperationalFiles([
      { name: "app.log", text: "ERROR boom" },
      { name: "broken.json", text: "{" },
      { name: "notes.pdf", text: "%PDF" },
    ]);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe("log");
    // Two rejections, each attributed to its own file — a batch that reported only
    // the first failure would leave the user fixing one file at a time.
    expect(result.errors.map((error) => error.source)).toEqual(["broken.json", "notes.pdf"]);
  });

  it("reads numbers out of either a number or a numeric string, and nothing out of prose", () => {
    expect(numberFrom({ a: 3 }, ["a"])).toBe(3);
    expect(numberFrom({ a: "3.5" }, ["a"])).toBe(3.5);
    expect(numberFrom({ a: "unknown" }, ["a"])).toBeNull();
    expect(numberFrom({}, ["a"])).toBeNull();
  });
});

describe("derived signals", () => {
  it("is empty for no entries, and reports itself as unavailable", () => {
    const signals = emptyOperationalSignals();

    expect(signals.available).toBe(false);
    expect(signals.entries).toBe(0);
    expect(signals.meanErrorRatePercent).toBeNull();
    expect(signals.worstUptimePercent).toBeNull();
    expect(describeSignals(signals)).toMatch(/No operational data/);
  });

  it("means error rates across services and takes the worst availability", () => {
    const signals = deriveOperationalSignals([
      entry({ source: "a.json", serviceName: "a", payload: { errorRatePercent: 2, uptimePercent: 99.99 } }),
      entry({ source: "b.json", serviceName: "b", payload: { errorRatePercent: 4, uptimePercent: 98.5 } }),
    ]);

    expect(signals.meanErrorRatePercent).toBe(3);
    // The minimum, not the mean: a user feels the service that was down, so an
    // availability figure averaged across healthy services would hide the one that
    // matters.
    expect(signals.worstUptimePercent).toBe(98.5);
    expect(signals.services).toEqual(["a", "b"]);
    expect(signals.available).toBe(true);
  });

  it("counts incidents and their critical subset from a structured report", () => {
    const signals = deriveOperationalSignals([
      entry({
        kind: "incident",
        source: "incidents.json",
        payload: {
          incidents: [
            { severity: "critical", summary: "checkout down" },
            { severity: "medium", summary: "slow search" },
            { severity: "sev1", summary: "auth outage" },
          ],
        },
      }),
    ]);

    expect(signals.incidentCount).toBe(3);
    expect(signals.criticalIncidentCount).toBe(2);
  });

  it("counts declared incidents in a free-text report, and says that is what it did", () => {
    const signals = deriveOperationalSignals([
      entry({
        kind: "incident",
        source: "incidents.txt",
        content: "2026-01-02 CRITICAL checkout outage\n2026-02-11 minor failure in search\nplain prose line",
      }),
    ]);

    expect(signals.criticalIncidentCount).toBe(1);
    expect(signals.incidentCount).toBe(2);
  });

  it("measures error-line density over the non-empty lines of a log", () => {
    const signals = deriveOperationalSignals([
      entry({ kind: "log", source: "app.log", content: "INFO a\nERROR b\nwarn c\n\nFATAL d" }),
    ]);

    expect(signals.totalLogLines).toBe(4);
    expect(signals.errorLogLines).toBe(2);
    expect(signals.errorLogDensity).toBe(0.5);
  });

  it("is order-independent, because every aggregate is a mean, a minimum or a count", () => {
    const first = entry({ source: "a.json", serviceName: "a", payload: { errorRatePercent: 2 } });
    const second = entry({ source: "b.json", serviceName: "b", payload: { errorRatePercent: 6 } });

    expect(deriveOperationalSignals([first, second])).toEqual(deriveOperationalSignals([second, first]));
  });
});

describe("the risk adjustment", () => {
  it("does nothing when no signals are available", () => {
    const adjustment = computeOperationalAdjustment(emptyOperationalSignals());

    expect(adjustment.applied).toBe(false);
    expect(adjustment.delta).toBe(0);
    expect(adjustment.terms).toEqual([]);
  });

  it("lowers Risk for healthy operational data", () => {
    const adjustment = computeOperationalAdjustment(
      deriveOperationalSignals([
        entry({ payload: { errorRatePercent: 0.1, uptimePercent: 99.99 } }),
        entry({ kind: "incident", source: "incidents.json", payload: { incidents: [] } }),
      ]),
    );

    expect(adjustment.applied).toBe(true);
    expect(adjustment.delta).toBeLessThan(0);
    // Healthy means *all* the way healthy: near-zero errors, near-perfect uptime and
    // an incident report that records nothing.
    expect(Math.abs(adjustment.delta)).toBeGreaterThan(5);
    expect(adjustment.reasons.join(" ")).toMatch(/Clean incident history/);
  });

  it("raises Risk for unhealthy operational data", () => {
    const adjustment = computeOperationalAdjustment(
      deriveOperationalSignals([
        entry({ payload: { errorRatePercent: 18, uptimePercent: 97.2 } }),
        entry({
          kind: "incident",
          source: "incidents.json",
          payload: { incidents: [{ severity: "critical" }, { severity: "critical" }, { severity: "low" }] },
        }),
        entry({ kind: "log", source: "app.log", content: "ERROR x\n".repeat(40) + "INFO y\n".repeat(10) }),
      ]),
    );

    expect(adjustment.delta).toBeGreaterThan(0);
    expect(adjustment.reasons.join(" ")).toMatch(/Measured error rate/);
    expect(adjustment.reasons.join(" ")).toMatch(/Critical incidents/);
  });

  it("is bounded in both directions, and says when the bound was hit", () => {
    const extreme = computeOperationalAdjustment(
      deriveOperationalSignals([
        entry({ payload: { errorRatePercent: 100, uptimePercent: 10 } }),
        entry({
          kind: "incident",
          source: "incidents.json",
          payload: { incidents: Array.from({ length: 20 }, () => ({ severity: "critical" })) },
        }),
        entry({ kind: "log", source: "app.log", content: "ERROR x\n".repeat(100) }),
      ]),
    );

    expect(extreme.delta).toBe(OPERATIONAL_RISK.maxAdjustment);
    expect(extreme.bounded).toBe(true);
    expect(extreme.unbounded).toBeGreaterThan(extreme.delta);
    expect(extreme.reasons.join(" ")).toMatch(/bounded to ±15/);
  });

  it("treats a log with no error lines as neutral rather than as evidence of health", () => {
    const adjustment = computeOperationalAdjustment(
      deriveOperationalSignals([entry({ kind: "log", source: "app.log", content: "INFO a\nINFO b" })]),
    );

    // A log is a sample, not a measurement: 200 clean lines from a quiet hour are
    // not evidence that a service is healthy, so they earn no credit.
    expect(adjustment.delta).toBe(0);
    expect(adjustment.applied).toBe(false);
  });

  it("reports restarts and database size without scoring them", () => {
    const adjustment = computeOperationalAdjustment(
      deriveOperationalSignals([
        entry({ payload: { restarts: 12, uptimePercent: 99.95 } }),
        entry({ kind: "db_stats", source: "db.json", payload: { databaseSizeMb: 51_200 } }),
      ]),
    );

    const reasons = adjustment.reasons.join(" ");
    expect(reasons).toMatch(/12 restart\(s\) were reported/);
    expect(reasons).toMatch(/51200 MB/);
    // Neither term appears as a scored contribution, because no threshold for them
    // is defensible yet — inventing one would be a number with no argument behind it.
    expect(adjustment.terms.map((term) => term.key)).not.toContain("restarts");
    expect(adjustment.terms.map((term) => term.key)).not.toContain("databaseSize");
  });
});
