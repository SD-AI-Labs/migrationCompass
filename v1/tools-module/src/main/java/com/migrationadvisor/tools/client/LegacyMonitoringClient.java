package com.migrationadvisor.tools.client;

import com.migrationadvisor.tools.controller.MonitoringDtos;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

import java.util.Optional;

/**
 * Thin HTTP client wrapping calls to the (mock) OrderVault monitoring API.
 * Kept separate from LegacySystemTools so the AI-facing tool layer stays
 * focused on describing *what* the tools do, not *how* the HTTP call works.
 */
@Component
public class LegacyMonitoringClient {

    private final RestClient restClient;

    public LegacyMonitoringClient(RestClient legacyMonitoringRestClient) {
        this.restClient = legacyMonitoringRestClient;
    }

    public Optional<MonitoringDtos.ServiceHealth> getHealth(String serviceName) {
        try {
            MonitoringDtos.ServiceHealth result = restClient.get()
                    .uri("/internal/legacy-monitoring/health/{serviceName}", serviceName)
                    .retrieve()
                    .body(MonitoringDtos.ServiceHealth.class);
            return Optional.ofNullable(result);
        } catch (RestClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                return Optional.empty();
            }
            throw e;
        }
    }

    public Optional<MonitoringDtos.ServiceTraffic> getTraffic(String serviceName) {
        try {
            MonitoringDtos.ServiceTraffic result = restClient.get()
                    .uri("/internal/legacy-monitoring/traffic/{serviceName}", serviceName)
                    .retrieve()
                    .body(MonitoringDtos.ServiceTraffic.class);
            return Optional.ofNullable(result);
        } catch (RestClientResponseException e) {
            if (e.getStatusCode().value() == 404) {
                return Optional.empty();
            }
            throw e;
        }
    }
}
