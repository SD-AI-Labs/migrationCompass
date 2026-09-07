package com.migrationadvisor.tools.controller;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;

/**
 * Optional upload of real operational data (health status + traffic
 * stats), replacing the bundled OrderVault example data. Matches
 * rag-module's UploadController pattern — "optional operational-data
 * upload alongside source code" for analyzing a real/generic project.
 *
 * If never called, the module keeps using the bundled OrderVault example
 * data — so it works out of the box either way.
 */
@RestController
@RequestMapping("/api/tools/upload")
public class UploadController {

    private final MockMonitoringDataService dataService;

    public UploadController(MockMonitoringDataService dataService) {
        this.dataService = dataService;
    }

    /**
     * Expects two files matching this module's existing schema (see
     * MonitoringDtos): one health-status JSON, one traffic-stats JSON.
     *
     * Example:
     *   curl -X POST localhost:8081/api/tools/upload/operational-data \
     *     -F "health=@my-health-status.json" \
     *     -F "traffic=@my-traffic-stats.json"
     */
    @PostMapping("/operational-data")
    public UploadResponse uploadOperationalData(
            @RequestParam("health") MultipartFile healthFile,
            @RequestParam("traffic") MultipartFile trafficFile) throws IOException {
        dataService.loadFrom(healthFile.getInputStream(), trafficFile.getInputStream());
        return new UploadResponse("Operational data replaced successfully.");
    }

    public record UploadResponse(String message) {}
}
