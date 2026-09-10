package com.migrationadvisor.agent.controller;

import com.migrationadvisor.agent.orchestrator.MigrationPlanningOrchestrator;
import com.migrationadvisor.agent.service.ArchitectureAgentService;
import com.migrationadvisor.agent.service.DiscoveryAgentService;
import com.migrationadvisor.agent.service.GroundTruthComparisonService;
import com.migrationadvisor.agent.service.RiskAgentService;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/agent")
public class AgentController {

    private final MigrationPlanningOrchestrator orchestrator;
    private final DiscoveryAgentService discoveryAgentService;
    private final ArchitectureAgentService architectureAgentService;
    private final RiskAgentService riskAgentService;
    private final GroundTruthComparisonService groundTruthComparisonService;

    public AgentController(
            MigrationPlanningOrchestrator orchestrator,
            DiscoveryAgentService discoveryAgentService,
            ArchitectureAgentService architectureAgentService,
            RiskAgentService riskAgentService,
            GroundTruthComparisonService groundTruthComparisonService) {
        this.orchestrator = orchestrator;
        this.discoveryAgentService = discoveryAgentService;
        this.architectureAgentService = architectureAgentService;
        this.riskAgentService = riskAgentService;
        this.groundTruthComparisonService = groundTruthComparisonService;
    }

    /**
     * Runs the FULL pipeline: Discovery -> Architecture + Risk -> Ground
     * Truth Comparison. This is the main "wow" demo endpoint, but it's
     * also the slowest (many tool calls across 3 separate LLM
     * conversations) — expect it to take a while.
     *
     * Requires rag-module (8082) and tools-module (8081) both running.
     *
     * projectId is OPTIONAL — pass it to run the analysis against a
     * SPECIFIC previously uploaded project (see GET /api/rag/projects for
     * the list to pick from); omit it to fall back to the
     * most-recently-uploaded project, same as before this parameter
     * existed.
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/analyze
     *   curl -X POST "localhost:8083/api/agent/analyze?projectId=..."
     */
    @PostMapping("/analyze")
    public MigrationPlanningOrchestrator.MigrationPlanResult analyzeFull(
            @RequestParam(value = "projectId", required = false) UUID projectId) {
        return orchestrator.runFullAnalysis(projectId);
    }

    /**
     * Standalone Discovery Agent step — useful for testing/debugging
     * without waiting for the full pipeline. Requires rag-module running.
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/discovery
     */
    @PostMapping("/discovery")
    public StepResponse discovery() {
        return new StepResponse(discoveryAgentService.analyze());
    }

    /**
     * Standalone Architecture Agent step. No external services required —
     * just needs a discovery report (e.g. from POST /api/agent/discovery)
     * passed in the request body.
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/architecture \
     *     -H "Content-Type: application/json" \
     *     -d '{"discoveryReport":"...paste discovery output here..."}'
     */
    @PostMapping("/architecture")
    public StepResponse architecture(@RequestBody DiscoveryReportRequest request) {
        return new StepResponse(architectureAgentService.proposeArchitecture(request.discoveryReport()));
    }

    /**
     * Standalone Risk Agent step. Requires tools-module running.
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/risk \
     *     -H "Content-Type: application/json" \
     *     -d '{"discoveryReport":"...paste discovery output here..."}'
     */
    @PostMapping("/risk")
    public StepResponse risk(@RequestBody DiscoveryReportRequest request) {
        return new StepResponse(riskAgentService.assessRisk(request.discoveryReport()));
    }

    /**
     * Standalone Comparison step, against the ground-truth docs. No
     * external services required — reads ground-truth/ from the local
     * filesystem directly (see GroundTruthComparisonService's javadoc for
     * why that's safe/intentional here specifically).
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/compare \
     *     -H "Content-Type: application/json" \
     *     -d '{"discoveryReport":"...","riskReport":"..."}'
     */
    @PostMapping("/compare")
    public StepResponse compare(@RequestBody CompareRequest request) {
        return new StepResponse(groundTruthComparisonService.compare(request.discoveryReport(), request.riskReport()));
    }

    public record DiscoveryReportRequest(String discoveryReport) {}
    public record CompareRequest(String discoveryReport, String riskReport) {}
    public record StepResponse(String result) {}
}
