package com.migrationadvisor.tools.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Simulates OrderVault's own internal monitoring/APM API. This is what the
 * AI tools in {@link com.migrationadvisor.tools.tool.LegacySystemTools} call
 * — real Spring Boot REST endpoints, not a shortcut straight to the data
 * layer, so the pattern matches how you'd actually integrate an AI agent
 * with a real legacy system's existing operational APIs.
 */
@RestController
@RequestMapping("/internal/legacy-monitoring")
public class MockLegacyMonitoringController {

    private final MockMonitoringDataService dataService;

    public MockLegacyMonitoringController(MockMonitoringDataService dataService) {
        this.dataService = dataService;
    }

    @GetMapping("/health")
    public MonitoringDtos.HealthStatusResponse fullHealth() {
        return dataService.fullHealth();
    }

    @GetMapping("/health/{serviceName}")
    public ResponseEntity<MonitoringDtos.ServiceHealth> healthFor(@PathVariable String serviceName) {
        return dataService.healthFor(serviceName)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/traffic")
    public MonitoringDtos.TrafficStatsResponse fullTraffic() {
        return dataService.fullTraffic();
    }

    @GetMapping("/traffic/{serviceName}")
    public ResponseEntity<MonitoringDtos.ServiceTraffic> trafficFor(@PathVariable String serviceName) {
        return dataService.trafficFor(serviceName)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
