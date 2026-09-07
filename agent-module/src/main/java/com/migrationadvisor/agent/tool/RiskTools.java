package com.migrationadvisor.agent.tool;

import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;

/**
 * Gives the Risk Agent access to the currently loaded project's LIVE
 * operational data — health status and traffic stats — by calling
 * tools-module's mock monitoring endpoints directly (not through
 * tools-module's own /api/tools-chat, which would mean routing through a
 * second LLM unnecessarily).
 *
 * This data may be the bundled OrderVault example, or data uploaded via
 * POST /api/tools/upload/operational-data for a real/generic project — or
 * there may be none at all if the user chose not to upload any, in which
 * case these tools return a clear "not found" response and the Risk Agent
 * is instructed (see AgentChatClientsConfig) to fall back to code-level
 * risk factors only.
 *
 * Requires tools-module to be running (default: localhost:8081).
 */
@Component
public class RiskTools {

    private final RestClient toolsServiceRestClient;

    public RiskTools(RestClient toolsServiceRestClient) {
        this.toolsServiceRestClient = toolsServiceRestClient;
    }

    @Tool(description = """
            Check the current operational health of a named service or
            component — status, 30-day uptime, cluster node health, and
            recent incidents. Use a service/component name you learned
            about from the Discovery findings. If this returns "no data
            found," that's expected when no operational data was uploaded
            for this project — don't treat it as an error, just note that
            operational signals aren't available for this assessment.
            """)
    public String checkApiHealth(
            @ToolParam(description = "The service/component name to check, as discovered from the codebase")
            String serviceName) {
        try {
            return toolsServiceRestClient.get()
                    .uri("/internal/legacy-monitoring/health/{serviceName}", serviceName)
                    .retrieve()
                    .body(String.class);
        } catch (RestClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                return "No health data found for service: " + serviceName;
            }
            return "ERROR calling health endpoint: " + e.getMessage();
        } catch (RestClientException e) {
            return "ERROR: could not reach tools-module for health data. Is it running? " + e.getMessage();
        }
    }

    @Tool(description = """
            Get current traffic statistics for a named service or
            component — request volume, response times, error rate, and
            how much traffic spikes during peak events. Use a
            service/component name you learned about from the Discovery
            findings. If this returns "no data found," that's expected
            when no operational data was uploaded for this project — don't
            treat it as an error, just note that operational signals
            aren't available for this assessment.
            """)
    public String getTrafficStats(
            @ToolParam(description = "The service/component name to check, as discovered from the codebase")
            String serviceName) {
        try {
            return toolsServiceRestClient.get()
                    .uri("/internal/legacy-monitoring/traffic/{serviceName}", serviceName)
                    .retrieve()
                    .body(String.class);
        } catch (RestClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                return "No traffic data found for service: " + serviceName;
            }
            return "ERROR calling traffic endpoint: " + e.getMessage();
        } catch (RestClientException e) {
            return "ERROR: could not reach tools-module for traffic data. Is it running? " + e.getMessage();
        }
    }
}
