package com.migrationadvisor.chat.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Simple health endpoint used by web-dashboard's status cards. Deliberately
 * lightweight (no Spring Boot Actuator dependency) — just enough to
 * confirm the module is up and reachable from the browser.
 */
@RestController
@RequestMapping("/api/health")
public class HealthController {

    @GetMapping
    public HealthResponse health() {
        return new HealthResponse("UP", "chat-module");
    }

    public record HealthResponse(String status, String module) {}
}
