package com.migrationadvisor.tools.controller;

import java.util.List;

/**
 * Shapes match test-data/mock-legacy-app/operational-data/*.json exactly.
 * These represent what a real APM/monitoring system for OrderVault would
 * expose — see that directory's source JSON for the full mock dataset.
 */
public class MonitoringDtos {

    public record TrafficStatsResponse(
            String generatedFor,
            String periodDescription,
            List<ServiceTraffic> services
    ) {}

    public record ServiceTraffic(
            String serviceName,
            long avgRequestsPerDay,
            int avgResponseTimeMs,
            int p99ResponseTimeMs,
            double errorRatePercent,
            double trafficSharePercent,
            double peakMultiplierDuringSales,
            String note
    ) {}

    public record HealthStatusResponse(
            String generatedFor,
            String clusterStatus,
            List<ServiceHealth> services,
            DatabaseHealth database
    ) {}

    public record ServiceHealth(
            String serviceName,
            String status,
            double uptimePercent30d,
            int activeNodes,
            int totalNodes,
            Incident lastIncident
    ) {}

    public record Incident(
            String date,
            String summary,
            int durationMinutes
    ) {}

    public record DatabaseHealth(
            String instanceName,
            String status,
            int connectionPoolUtilizationPercent,
            String note
    ) {}
}
