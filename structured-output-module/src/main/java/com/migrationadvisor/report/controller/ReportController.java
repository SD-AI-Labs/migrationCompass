package com.migrationadvisor.report.controller;

import com.migrationadvisor.report.model.MigrationReport;
import com.migrationadvisor.report.service.FullPipelineReportService;
import com.migrationadvisor.report.service.StructuredReportService;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/api/report")
public class ReportController {

    private final StructuredReportService structuredReportService;
    private final FullPipelineReportService fullPipelineReportService;

    public ReportController(StructuredReportService structuredReportService, FullPipelineReportService fullPipelineReportService) {
        this.structuredReportService = structuredReportService;
        this.fullPipelineReportService = fullPipelineReportService;
    }

    /**
     * Standalone — you supply the three agent reports directly (e.g.
     * copy-pasted from agent-module's individual step endpoints). No other
     * services need to be running for this one.
     *
     * Example:
     *   curl -X POST localhost:8084/api/report/generate \
     *     -H "Content-Type: application/json" \
     *     -d '{"discoveryReport":"...","architectureProposal":"...","riskAssessment":"..."}'
     */
    @PostMapping("/generate")
    public MigrationReport generate(@RequestBody GenerateRequest request) {
        return structuredReportService.generateReport(
                request.discoveryReport(), request.architectureProposal(), request.riskAssessment());
    }

    /**
     * The "always fresh" path — calls agent-module's full pipeline
     * automatically (a brand-new run every time), then extracts the
     * structured report from its output. Requires agent-module (which
     * itself requires rag-module and tools-module) all running. Slow —
     * it's running the entire agent pipeline plus one more LLM call for
     * the extraction. See POST /generate-for-project/{projectId} for a
     * version that reuses an existing run instead of always re-running
     * everything.
     *
     * projectId is OPTIONAL — pass it to run the analysis against a
     * SPECIFIC previously uploaded project; omit it to fall back to the
     * most-recently-uploaded project, same as before this parameter
     * existed.
     *
     * Example:
     *   curl -X POST localhost:8084/api/report/generate-from-pipeline
     *   curl -X POST "localhost:8084/api/report/generate-from-pipeline?projectId=..."
     */
    @PostMapping("/generate-from-pipeline")
    public MigrationReport generateFromPipeline(@RequestParam(value = "projectId", required = false) UUID projectId) {
        return fullPipelineReportService.generateFromLivePipeline(projectId);
    }

    /**
     * The "avoid re-calling the LLM" path — reuses the latest COMPLETE
     * agent-module run for this project instead of always starting a
     * fresh one:
     *
     * - Already has a structured report cached from a previous call?
     *   Returned directly — ZERO LLM calls.
     * - Has a completed run but no structured report yet? One LLM call
     *   (just the extraction step — Discovery/Architecture/Risk/Comparison
     *   are NOT re-run).
     * - No completed run exists yet for this project? Falls back to
     *   running the full live pipeline (same cost as
     *   /generate-from-pipeline?projectId=...).
     *
     * Example:
     *   curl -X POST localhost:8084/api/report/generate-for-project/{projectId}
     */
    @PostMapping("/generate-for-project/{projectId}")
    public MigrationReport generateForProject(@PathVariable UUID projectId) {
        return fullPipelineReportService.generateForProject(projectId);
    }

    public record GenerateRequest(String discoveryReport, String architectureProposal, String riskAssessment) {}
}
