package com.migrationadvisor.agent.controller;

import com.migrationadvisor.agent.service.AsyncJobService;
import com.migrationadvisor.agent.service.StepDurationEstimator;
import com.migrationadvisor.persistence.entity.AnalysisRun;
import com.migrationadvisor.persistence.repository.AnalysisRunRepository;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * Async alternative to POST /api/agent/analyze (see AgentController) —
 * returns immediately with a runId instead of blocking for minutes. This
 * is what a real GUI should use: start the job, poll status for progress
 * (current step, elapsed time, estimated remaining), then fetch the
 * result once complete.
 *
 * The original synchronous endpoint still exists unchanged, for quick
 * curl-based testing and structured-output-module's existing pipeline
 * composition.
 */
@RestController
@RequestMapping("/api/agent/analyze")
public class AsyncAgentController {

    private final AsyncJobService asyncJobService;
    private final AnalysisRunRepository analysisRunRepository;
    private final StepDurationEstimator stepDurationEstimator;

    public AsyncAgentController(
            AsyncJobService asyncJobService,
            AnalysisRunRepository analysisRunRepository,
            StepDurationEstimator stepDurationEstimator) {
        this.asyncJobService = asyncJobService;
        this.analysisRunRepository = analysisRunRepository;
        this.stepDurationEstimator = stepDurationEstimator;
    }

    /**
     * Starts the full pipeline asynchronously and returns immediately.
     *
     * projectId is OPTIONAL — pass it to run the analysis against a
     * SPECIFIC previously uploaded project (see GET /api/rag/projects for
     * the list to pick from); omit it to fall back to the
     * most-recently-uploaded project, same as before this parameter
     * existed.
     *
     * Example:
     *   curl -X POST localhost:8083/api/agent/analyze/start
     *   curl -X POST "localhost:8083/api/agent/analyze/start?projectId=..."
     */
    @PostMapping("/start")
    public StartResponse start(@RequestParam(value = "projectId", required = false) UUID projectId) {
        UUID runId = asyncJobService.startJob(projectId);
        return new StartResponse(runId);
    }

    /**
     * Poll this for live progress — current step, elapsed time, and an
     * estimated remaining time computed from past completed runs' actual
     * step durations (falls back to a static estimate for the very first
     * run ever, before any history exists).
     *
     * Example:
     *   curl localhost:8083/api/agent/analyze/status/{runId}
     */
    @GetMapping("/status/{runId}")
    public ResponseEntity<StatusResponse> status(@PathVariable UUID runId) {
        return analysisRunRepository.findById(runId)
                .map(run -> ResponseEntity.ok(toStatusResponse(run)))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Fetch the final result once status shows COMPLETE. Returns 409 if
     * the run is still in progress, or the failure state if it failed.
     *
     * Example:
     *   curl localhost:8083/api/agent/analyze/result/{runId}
     */
    @GetMapping("/result/{runId}")
    public ResponseEntity<?> result(@PathVariable UUID runId) {
        return analysisRunRepository.findById(runId)
                .<ResponseEntity<?>>map(run -> switch (run.getStatus()) {
                    case COMPLETE -> ResponseEntity.ok(new ResultResponse(
                            run.getId(), run.getDiscoveryReport(), run.getArchitectureProposal(),
                            run.getRiskAssessment(), run.getGroundTruthComparison()));
                    case FAILED -> ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                            .body(new ErrorResponse("Run failed — check agent-module's server logs for details."));
                    case RUNNING -> ResponseEntity.status(HttpStatus.CONFLICT)
                            .body(new ErrorResponse("Run still in progress — poll /status/" + runId + " first."));
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    private StatusResponse toStatusResponse(AnalysisRun run) {
        // Handle potentially null timestamps from old runs
        long elapsedSeconds = 0L;
        if (run.getStartedAt() != null) {
            elapsedSeconds = Duration.between(run.getStartedAt(), Instant.now()).getSeconds();
        }
        
        Long estimatedRemaining = stepDurationEstimator.estimateRemainingSeconds(run);
        String currentStep = run.getCurrentStep() != null ? run.getCurrentStep().name() : "UNKNOWN";
        
        return new StatusResponse(
                run.getId(), run.getStatus().name(), currentStep,
                elapsedSeconds, estimatedRemaining);
    }

    public record StartResponse(UUID runId) {}
    public record StatusResponse(UUID runId, String status, String currentStep, long elapsedSeconds, Long estimatedRemainingSeconds) {}
    public record ResultResponse(UUID runId, String discoveryReport, String architectureProposal, String riskAssessment, String groundTruthComparison) {}
    public record ErrorResponse(String message) {}
}
