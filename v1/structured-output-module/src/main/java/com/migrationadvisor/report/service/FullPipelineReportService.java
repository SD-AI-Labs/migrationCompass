package com.migrationadvisor.report.service;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.migrationadvisor.persistence.entity.AnalysisRun;
import com.migrationadvisor.persistence.repository.AnalysisRunRepository;
import com.migrationadvisor.report.model.MigrationReport;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.util.UUID;

/**
 * Composes agent-module's full pipeline (POST /api/agent/analyze) to fetch
 * the three source reports automatically, then hands them to
 * StructuredReportService — the "one call does everything" path.
 *
 * Also attaches the resulting structured report back onto the same
 * AnalysisRun record agent-module already created (using the runId in its
 * response), via the SAME shared Postgres database (persistence-module) —
 * not another HTTP round-trip. This closes the loop so a single run's full
 * history (all 4 text reports + the final structured JSON) lives in one
 * place, which is what the eventual GUI's report-history tab reads from.
 *
 * Requires agent-module running (default: localhost:8083), which in turn
 * requires rag-module and tools-module running — see agent-module's README
 * section for the full startup chain.
 */
@Service
public class FullPipelineReportService {

    private final RestClient agentServiceRestClient;
    private final StructuredReportService structuredReportService;
    private final AnalysisRunRepository analysisRunRepository;
    private final ObjectMapper objectMapper;

    public FullPipelineReportService(
            RestClient agentServiceRestClient,
            StructuredReportService structuredReportService,
            AnalysisRunRepository analysisRunRepository,
            ObjectMapper objectMapper) {
        this.agentServiceRestClient = agentServiceRestClient;
        this.structuredReportService = structuredReportService;
        this.analysisRunRepository = analysisRunRepository;
        this.objectMapper = objectMapper;
    }

    /** Always runs a brand-new full pipeline, against the most-recently-uploaded project. */
    public MigrationReport generateFromLivePipeline() {
        return generateFromLivePipeline(null);
    }

    /**
     * Always runs a brand-new full pipeline against a SPECIFIC project —
     * projectId may be null to fall back to the most-recently-uploaded
     * project (unchanged default behavior). This is the "always fresh"
     * path; see generateForProject(UUID) for the caching path that avoids
     * re-running the pipeline (and re-calling the LLM) when a completed
     * run for the project already exists.
     */
    public MigrationReport generateFromLivePipeline(UUID projectId) {
        try {
            AgentAnalyzeResponse agentResult = agentServiceRestClient.post()
                    .uri(uriBuilder -> {
                        var b = uriBuilder.path("/api/agent/analyze");
                        if (projectId != null) {
                            b = b.queryParam("projectId", projectId);
                        }
                        return b.build();
                    })
                    .retrieve()
                    .body(AgentAnalyzeResponse.class);

            if (agentResult == null) {
                throw new IllegalStateException("agent-module returned no response — is it running on the expected port?");
            }

            MigrationReport report = structuredReportService.generateReport(
                    agentResult.discoveryReport(),
                    agentResult.architectureProposal(),
                    agentResult.riskAssessment());

            attachToRun(agentResult.runId(), report);

            return report;
        } catch (Exception e) {
            System.err.println("[FullPipelineReportService] Error calling agent pipeline: " + e.getMessage());
            e.printStackTrace(System.err);
            throw new RuntimeException("Failed to generate report from agent pipeline: " + e.getMessage(), e);
        }
    }

    /**
     * The "avoid re-calling the LLM" path: reuses an existing COMPLETE run
     * for this project if one exists, rather than always kicking off a
     * fresh 4-agent pipeline.
     *
     * - If a completed run exists AND already has a structured report
     *   attached (e.g. from an earlier call to this same method, or from
     *   generateFromLivePipeline): returns the cached JSON directly.
     *   ZERO LLM calls.
     * - If a completed run exists but has no structured report attached
     *   yet: reuses its saved discovery/architecture/risk text and does
     *   ONLY the one structured-extraction LLM call (skips re-running
     *   Discovery/Architecture/Risk/Comparison entirely).
     * - If no completed run exists yet for this project: falls back to
     *   generateFromLivePipeline(projectId) — there's nothing to reuse,
     *   so this is the same cost as calling that directly.
     */
    public MigrationReport generateForProject(UUID projectId) {
        return analysisRunRepository
                .findFirstByProjectIdAndStatusOrderByStartedAtDesc(projectId, AnalysisRun.Status.COMPLETE)
                .map(this::reuseOrExtractFrom)
                .orElseGet(() -> generateFromLivePipeline(projectId));
    }

    private MigrationReport reuseOrExtractFrom(AnalysisRun run) {
        if (run.getStructuredReportJson() != null) {
            try {
                return objectMapper.readValue(run.getStructuredReportJson(), MigrationReport.class);
            } catch (Exception e) {
                System.err.println("[FullPipelineReportService] Cached structured report for run " +
                        run.getId() + " failed to parse, regenerating: " + e.getMessage());
                // fall through and regenerate below
            }
        }

        MigrationReport report = structuredReportService.generateReport(
                run.getDiscoveryReport(), run.getArchitectureProposal(), run.getRiskAssessment());
        attachToRun(run.getId(), report);
        return report;
    }

    private void attachToRun(UUID runId, MigrationReport report) {
        if (runId == null) {
            System.err.println("[FullPipelineReportService] agent-module response had no runId — " +
                    "skipping attachment to history (older agent-module version?)");
            return;
        }
        analysisRunRepository.findById(runId).ifPresentOrElse(
                run -> {
                    try {
                        run.attachStructuredReport(objectMapper.writeValueAsString(report));
                        analysisRunRepository.save(run);
                        System.out.println("[FullPipelineReportService] Structured report attached to run " + runId);
                    } catch (Exception e) {
                        System.err.println("[FullPipelineReportService] Failed to serialize/attach structured report: " + e.getMessage());
                    }
                },
                () -> System.err.println("[FullPipelineReportService] Run " + runId + " not found — cannot attach structured report (unexpected: same database as agent-module)")
        );
    }

    // Mirrors agent-module's MigrationPlanningOrchestrator.MigrationPlanResult
    // shape. Kept as a private local copy rather than importing agent-module
    // directly, since these two modules otherwise have no compile-time
    // dependency on each other — they only talk over HTTP for the actual
    // pipeline execution, matching how agent-module itself composes
    // rag-module/tools-module. (The shared DB access below is a separate,
    // deliberate exception — see class javadoc.)
    private record AgentAnalyzeResponse(
            UUID runId,
            String discoveryReport,
            String architectureProposal,
            String riskAssessment,
            String groundTruthComparison
    ) {}
}
