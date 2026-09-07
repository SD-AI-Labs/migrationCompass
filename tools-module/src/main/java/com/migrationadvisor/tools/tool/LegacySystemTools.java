package com.migrationadvisor.tools.tool;

import com.migrationadvisor.tools.client.LegacyMonitoringClient;
import com.migrationadvisor.tools.controller.MockMonitoringDataService;
import com.migrationadvisor.tools.controller.MonitoringDtos;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

/**
 * Tools the AI can call to inspect the currently loaded project's live
 * operational state. This data may be the bundled OrderVault example, or
 * data uploaded for a real/generic project via
 * POST /api/tools/upload/operational-data (see UploadController) — this
 * class doesn't know or care which, and deliberately has no hardcoded
 * service names of its own.
 *
 * Registered with a ChatClient via .tools(new LegacySystemTools(...)) or
 * .defaultTools(...) — see ToolsChatConfig.
 */
@Component
public class LegacySystemTools {

    private final LegacyMonitoringClient monitoringClient;
    private final MockMonitoringDataService dataService;

    public LegacySystemTools(LegacyMonitoringClient monitoringClient, MockMonitoringDataService dataService) {
        this.monitoringClient = monitoringClient;
        this.dataService = dataService;
    }

    @Tool(description = """
            Check the current operational health of a service in the
            currently loaded project. Returns status (HEALTHY/DEGRADED),
            uptime over the last 30 days, active vs total cluster nodes,
            and details of the most recent incident if any. Call this with
            a service/component name you've learned about from the
            knowledge base — if you're unsure of the exact name, this tool
            will tell you what's actually available.
            """)
    public String checkApiHealth(
            @ToolParam(description = "The exact service/component name to check, as discovered from the codebase")
            String serviceName) {

        return monitoringClient.getHealth(serviceName)
                .map(this::formatHealth)
                .orElseGet(() -> "No health data found for service: " + serviceName +
                        ". Services with available data: " + dataService.knownServiceNames());
    }

    @Tool(description = """
            Get current traffic statistics for a service in the currently
            loaded project, including average and p99 response times,
            error rate, share of total system traffic, and how much
            traffic spikes during peak events. Useful for assessing
            migration risk and load-related concerns. Call this with a
            service/component name you've learned about from the knowledge
            base — if you're unsure of the exact name, this tool will tell
            you what's actually available.
            """)
    public String getTrafficStats(
            @ToolParam(description = "The exact service/component name to check, as discovered from the codebase")
            String serviceName) {

        return monitoringClient.getTraffic(serviceName)
                .map(this::formatTraffic)
                .orElseGet(() -> "No traffic data found for service: " + serviceName +
                        ". Services with available data: " + dataService.knownServiceNames());
    }

    private String formatHealth(MonitoringDtos.ServiceHealth h) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.format(
                "%s: status=%s, uptime(30d)=%.2f%%, nodes=%d/%d active",
                h.serviceName(), h.status(), h.uptimePercent30d(), h.activeNodes(), h.totalNodes()));
        if (h.lastIncident() != null) {
            sb.append(String.format(
                    ". Last incident on %s (%d min): %s",
                    h.lastIncident().date(), h.lastIncident().durationMinutes(), h.lastIncident().summary()));
        } else {
            sb.append(". No recent incidents.");
        }
        return sb.toString();
    }

    private String formatTraffic(MonitoringDtos.ServiceTraffic t) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.format(
                "%s: ~%,d requests/day (%.1f%% of total traffic), avg response %dms, p99 %dms, error rate %.2f%%, spikes up to %.1fx during peak events",
                t.serviceName(), t.avgRequestsPerDay(), t.trafficSharePercent(),
                t.avgResponseTimeMs(), t.p99ResponseTimeMs(), t.errorRatePercent(), t.peakMultiplierDuringSales()));
        if (t.note() != null && !t.note().isBlank()) {
            sb.append(". Note: ").append(t.note());
        }
        return sb.toString();
    }
}
