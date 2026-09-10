import { oneStringArgument, renderToolPayload, toolFailure } from "./types";
import type { AgentTool, ToolResult } from "./types";

/**
 * Operational-signal tools: `checkApiHealth` and `getTrafficStats`.
 *
 * Reframed from V1 exactly as the plan describes — in V1 these were a *chat
 * surface* ("chat with the monitoring data"); here they are a *data source* the
 * Risk Agent consults. The tool interface is unchanged in spirit, which is why
 * V1's key behavioural rule carries over verbatim:
 *
 *   **"No data for this service" is a successful answer, not an error.**
 *
 * A service with no operational data is not a failure to report; it is the normal
 * case for a code-only estimate, and the Risk Agent is instructed to fall back to
 * code-level signals when it sees it. Returning an error instead would push the
 * model toward inventing numbers, which is the one outcome that would make the
 * whole risk assessment untrustworthy.
 *
 * M5 adds the ingestion that fills `operational_data`. M3 defines the boundary and
 * the honest empty case, which is why this module has no ingestion code in it.
 */

export type MonitoringEntry = Record<string, unknown>;

export type MonitoringSource = {
  /** Health/traffic signals for one named service, or null when none exist. */
  health(projectId: string, serviceName: string): Promise<MonitoringEntry | null>;
  traffic(projectId: string, serviceName: string): Promise<MonitoringEntry | null>;
};

export const CHECK_HEALTH_TOOL_NAME = "checkApiHealth";
export const TRAFFIC_STATS_TOOL_NAME = "getTrafficStats";

const HEALTH_DESCRIPTION =
  "Check the current operational health of a named service or component — status, uptime, " +
  "node health, and recent incidents. If this reports that no data is available, that is " +
  "expected when no operational data was supplied for this project: note it plainly and base " +
  "your assessment on code-level and log-based signals instead. Never invent operational numbers.";

const TRAFFIC_DESCRIPTION =
  "Get current traffic statistics for a named service or component — request volume, response " +
  "times, error rate, and peak-load behaviour. If this reports that no data is available, that " +
  "is expected when no operational data was supplied for this project — note it plainly rather " +
  "than estimating.";

/**
 * Case-insensitive, punctuation-insensitive service-name matching.
 *
 * A model will ask about "OrderLookupService" when the stored key is
 * "order-lookup-service". Exact matching turns that into a false "no data", which
 * is a wrong answer rather than a missing one — the model would conclude the
 * service has no operational data when it does.
 */
export function normalizeServiceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** True when an entry describes the named service, whatever key convention it uses. */
export function entryMatchesService(entry: MonitoringEntry, serviceName: string): boolean {
  const target = normalizeServiceName(serviceName);
  if (target.length === 0) return false;

  const candidates = [entry.service, entry.serviceName, entry.component, entry.name];
  return candidates.some(
    (candidate) => typeof candidate === "string" && normalizeServiceName(candidate) === target,
  );
}

/** First entry matching the service, or null. Pure — the DB source uses it. */
export function selectServiceEntry(
  entries: MonitoringEntry[],
  serviceName: string,
): MonitoringEntry | null {
  return entries.find((entry) => entryMatchesService(entry, serviceName)) ?? null;
}

function serviceTool(options: {
  name: string;
  description: string;
  kind: "health" | "traffic";
  source: MonitoringSource;
}): AgentTool<{ serviceName: string }> {
  return {
    name: options.name,
    description: options.description,
    parameters: oneStringArgument(
      "serviceName",
      "The service/component name to check, using a name discovered from the codebase inventory",
    ),
    async run(input, context): Promise<ToolResult> {
      const serviceName = input.serviceName?.trim();
      if (!serviceName) {
        return { ok: false, content: `ERROR: ${options.name} requires a service name.` };
      }

      try {
        const entry =
          options.kind === "health"
            ? await options.source.health(context.projectId, serviceName)
            : await options.source.traffic(context.projectId, serviceName);

        if (entry === null) {
          return {
            ok: true,
            content:
              `No ${options.kind} data found for service: ${serviceName}. ` +
              `No operational data has been supplied for this project, so this assessment ` +
              `rests on static code and log evidence.`,
          };
        }

        return { ok: true, content: renderToolPayload(entry) };
      } catch (error) {
        return toolFailure(options.name, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function createMonitoringTools(source: MonitoringSource): {
  checkApiHealth: AgentTool<{ serviceName: string }>;
  getTrafficStats: AgentTool<{ serviceName: string }>;
} {
  return {
    checkApiHealth: serviceTool({
      name: CHECK_HEALTH_TOOL_NAME,
      description: HEALTH_DESCRIPTION,
      kind: "health",
      source,
    }),
    getTrafficStats: serviceTool({
      name: TRAFFIC_STATS_TOOL_NAME,
      description: TRAFFIC_DESCRIPTION,
      kind: "traffic",
      source,
    }),
  };
}
