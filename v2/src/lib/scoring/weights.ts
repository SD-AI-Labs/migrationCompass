import { RISK_LEVEL_VALUES, clamp, round, type RiskLevel } from "./assumptions";

/**
 * Risk aggregation weighting.
 *
 * The plan ships equal weighting as the v1 formula and flags dependency weighting
 * as the concrete refinement the dependency graph makes possible: "a highly-
 * depended-on service failing should weigh more than a leaf service". Both are
 * supported here behind one switch, because the plan asks to prototype both and
 * compare on real runs — so this is not a feature flag, it is the comparison.
 *
 * The property that makes dependency weighting defensible: **with no edges
 * recorded, it is identical to equal weighting.** Every service has a floor weight
 * of 1, so an empty graph degrades to the documented v1 behaviour rather than to
 * something else. A test asserts exactly that.
 */

export const RISK_WEIGHTINGS = ["equal", "dependency"] as const;
export type RiskWeighting = (typeof RISK_WEIGHTINGS)[number];

/** Mirrors the `risk_weighting` column, so a scorecard records which mode produced it. */
export const DEFAULT_RISK_WEIGHTING: RiskWeighting = "equal";

export type WeightableService = {
  serviceName: string;
  riskLevel: RiskLevel;
  /** How many other services depend on this one, from the persisted edges. */
  dependentCount: number;
};

export type ServiceWeight = {
  serviceName: string;
  riskLevel: RiskLevel;
  riskValue: number;
  /** Raw weight before normalization. */
  weight: number;
  /** Normalized share, so the weighted terms sum to the aggregate directly. */
  share: number;
  /** This service's contribution to the 0–100 risk score: share × riskValue. */
  contribution: number;
};

/** Smallest weight a service can carry, so no service is ever weighted out entirely. */
export const MIN_SERVICE_WEIGHT = 1;

/**
 * Raw weight for one service.
 *
 * Dependency mode uses `1 + dependentCount` rather than `dependentCount`: a leaf
 * service is not irrelevant, it is just not load-bearing. Using the count alone
 * would give leaves zero weight and drop them from the aggregate entirely, which
 * is a different (and wrong) claim from "weighs less".
 */
export function rawWeightFor(service: WeightableService, mode: RiskWeighting): number {
  if (mode === "equal") return MIN_SERVICE_WEIGHT;
  return MIN_SERVICE_WEIGHT + Math.max(0, service.dependentCount);
}

/** Normalized shares for the inventory, summing to 1 (or all-zero for an empty inventory). */
export function computeRiskWeights(
  services: WeightableService[],
  mode: RiskWeighting = DEFAULT_RISK_WEIGHTING,
): ServiceWeight[] {
  const total = services.reduce((sum, service) => sum + rawWeightFor(service, mode), 0);

  return services.map((service) => {
    const weight = rawWeightFor(service, mode);
    const share = total > 0 ? weight / total : 0;
    const riskValue = RISK_LEVEL_VALUES[service.riskLevel];

    return {
      serviceName: service.serviceName,
      riskLevel: service.riskLevel,
      riskValue,
      weight,
      share,
      contribution: share * riskValue,
    };
  });
}

/**
 * The 0–100 risk aggregate: the weighted mean of per-service risk levels, clamped
 * to the documented bounds.
 *
 * An empty inventory scores 0 rather than an error or a midpoint. That is a
 * deliberate choice: "we found nothing to assess" is not "average risk", and
 * inventing 50 would put a number on the scorecard that no finding supports. The
 * scorecard's evidence-quality tag is what communicates that the input was empty.
 */
export function computeRiskScore(
  services: WeightableService[],
  mode: RiskWeighting = DEFAULT_RISK_WEIGHTING,
): number {
  if (services.length === 0) return 0;

  const weights = computeRiskWeights(services, mode);
  const total = weights.reduce((sum, service) => sum + service.contribution, 0);
  return clamp(round(total, 2), 0, 100);
}

/** Convenience for callers holding only findings: dependent counts come from the edges. */
export function dependentCountsFromEdges(
  edges: { fromService: string; toService: string }[],
): Map<string, number> {
  const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dependents = new Map<string, Set<string>>();

  for (const edge of edges) {
    const target = key(edge.toService);
    const source = key(edge.fromService);
    if (target.length === 0 || source.length === 0 || target === source) continue;
    const existing = dependents.get(target) ?? new Set<string>();
    existing.add(source);
    dependents.set(target, existing);
  }

  return new Map([...dependents.entries()].map(([service, sources]) => [service, sources.size]));
}
