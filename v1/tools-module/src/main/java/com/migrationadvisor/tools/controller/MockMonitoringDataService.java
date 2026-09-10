package com.migrationadvisor.tools.controller;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Holds the currently active operational data (health status + traffic
 * stats). Loads the bundled OrderVault example data as the default at
 * startup, but this can be replaced entirely via
 * POST /api/tools/upload/operational-data — this is the "optional
 * operational-data upload alongside source code" capability for analyzing
 * a real/generic project rather than just the OrderVault example.
 *
 * In a real system, this class would be replaced by an actual APM client
 * (Datadog, Dynatrace, WebLogic's own JMX metrics, etc.) — the REST
 * endpoints and tool methods built on top of it wouldn't need to change.
 */
@Service
public class MockMonitoringDataService {

    private final ObjectMapper objectMapper;
    private final AtomicReference<MonitoringDtos.HealthStatusResponse> healthData = new AtomicReference<>();
    private final AtomicReference<MonitoringDtos.TrafficStatsResponse> trafficData = new AtomicReference<>();

    public MockMonitoringDataService() throws IOException {
        this.objectMapper = new ObjectMapper()
                // The bundled mock JSON files include a "_comment" field
                // (a note that the data is synthetic) which isn't part of
                // the DTO shape — ignore unknown fields rather than
                // failing on them. Also matters for arbitrary uploaded
                // operational data, which may include extra fields too.
                .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

        // Load the bundled OrderVault example as the default, so the
        // module works out of the box without requiring an upload first.
        loadFrom(
                new ClassPathResource("legacy-data/health-status.json").getInputStream(),
                new ClassPathResource("legacy-data/traffic-stats.json").getInputStream());
    }

    /** Replaces the currently active data — used by UploadController. */
    public void loadFrom(InputStream healthJson, InputStream trafficJson) throws IOException {
        healthData.set(objectMapper.readValue(healthJson, MonitoringDtos.HealthStatusResponse.class));
        trafficData.set(objectMapper.readValue(trafficJson, MonitoringDtos.TrafficStatsResponse.class));
    }

    public MonitoringDtos.HealthStatusResponse fullHealth() {
        return healthData.get();
    }

    public MonitoringDtos.TrafficStatsResponse fullTraffic() {
        return trafficData.get();
    }

    /** Used to build a helpful hint when a tool call names an unknown service. */
    public java.util.List<String> knownServiceNames() {
        return healthData.get().services().stream()
                .map(MonitoringDtos.ServiceHealth::serviceName)
                .distinct()
                .toList();
    }

    public Optional<MonitoringDtos.ServiceHealth> healthFor(String serviceName) {
        return healthData.get().services().stream()
                .filter(s -> s.serviceName().equalsIgnoreCase(serviceName))
                .findFirst();
    }

    public Optional<MonitoringDtos.ServiceTraffic> trafficFor(String serviceName) {
        return trafficData.get().services().stream()
                .filter(s -> s.serviceName().equalsIgnoreCase(serviceName))
                .findFirst();
    }
}
