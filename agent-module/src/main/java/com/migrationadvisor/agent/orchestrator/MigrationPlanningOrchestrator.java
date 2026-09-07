package com.migrationadvisor.agent.orchestrator;

import com.migrationadvisor.agent.service.ArchitectureAgentService;
import com.migrationadvisor.agent.service.DiscoveryAgentService;
import com.migrationadvisor.agent.service.GroundTruthComparisonService;
import com.migrationadvisor.agent.service.RiskAgentService;
import com.migrationadvisor.common.logging.CorrelationIdFilter;
import com.migrationadvisor.persistence.entity.AnalysisRun;
import com.migrationadvisor.persistence.entity.Project;
import com.migrationadvisor.persistence.repository.AnalysisRunRepository;
import com.migrationadvisor.persistence.repository.ProjectRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Runs the full multi-agent migration-planning pipeline: Discovery ->
 * Architecture + Risk (both depend on Discovery's output, but are
 * independent of each other) -> Comparison against ground truth. Persists
 * progress at every step transition (see AnalysisRun.advanceTo), so status
 * can be polled from the DB regardless of which thread is doing the work.
 *
 * Split into three entry points for two different callers:
 *
 * - {@link #runFullAnalysis()} — SYNCHRONOUS. Creates the run and executes
 *   it on the calling thread, blocking until done. Used by the original
 *   POST /api/agent/analyze endpoint and by structured-output-module's
 *   pipeline composition — unchanged behavior from before this class had
 *   async support.
 *
 * - {@link #createRun()} + {@link #executeRunAsync(AnalysisRun)} — ASYNC.
 *   Used by AsyncJobService: createRun() returns immediately with a
 *   persisted RUNNING row (so the caller has a runId right away),
 *   executeRunAsync() then does the actual work on a virtual thread (see
 *   application.yml's spring.threads.virtual.enabled) without blocking
 *   whoever called createRun().
 *
 * Both paths share the same step-by-step execution logic (see
 * {@link #executeRun(AnalysisRun)}) — there's exactly one place the
 * pipeline's actual sequencing is defined.
 */
@Service
public class MigrationPlanningOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(MigrationPlanningOrchestrator.class);

    private final DiscoveryAgentService discoveryAgentService;
    private final ArchitectureAgentService architectureAgentService;
    private final RiskAgentService riskAgentService;
    private final GroundTruthComparisonService groundTruthComparisonService;
    private final ProjectRepository projectRepository;
    private final AnalysisRunRepository analysisRunRepository;

    public MigrationPlanningOrchestrator(
            DiscoveryAgentService discoveryAgentService,
            ArchitectureAgentService architectureAgentService,
            RiskAgentService riskAgentService,
            GroundTruthComparisonService groundTruthComparisonService,
            ProjectRepository projectRepository,
            AnalysisRunRepository analysisRunRepository) {
        this.discoveryAgentService = discoveryAgentService;
        this.architectureAgentService = architectureAgentService;
        this.riskAgentService = riskAgentService;
        this.groundTruthComparisonService = groundTruthComparisonService;
        this.projectRepository = projectRepository;
        this.analysisRunRepository = analysisRunRepository;
    }

    /** Synchronous convenience wrapper — blocks the calling thread until the full pipeline completes, against the most-recently-uploaded project. */
    public MigrationPlanResult runFullAnalysis() {
        return runFullAnalysis(null);
    }

    /**
     * Synchronous convenience wrapper for a SPECIFIC project — blocks the
     * calling thread until the full pipeline completes. projectId may be
     * null to fall back to the most-recently-uploaded project (unchanged
     * default behavior).
     */
    public MigrationPlanResult runFullAnalysis(UUID projectId) {
        AnalysisRun run = createRun(projectId);
        return executeRun(run);
    }

    /** Creates and persists a new RUNNING AnalysisRun immediately (against the most-recently-uploaded project), without doing any of the actual work yet. */
    public AnalysisRun createRun() {
        return createRun(null);
    }

    /**
     * Creates and persists a new RUNNING AnalysisRun immediately, without
     * doing any of the actual work yet, against a SPECIFIC project.
     * projectId may be null to fall back to the most-recently-uploaded
     * project (unchanged default behavior) — otherwise it's validated to
     * actually exist, so picking a stale/mistyped project ID fails fast
     * here rather than surfacing confusingly later as an empty Discovery
     * report.
     */
    public AnalysisRun createRun(UUID projectId) {
        UUID resolvedProjectId = projectId != null ? validateProjectExists(projectId) : findCurrentProjectId();
        return analysisRunRepository.save(new AnalysisRun(resolvedProjectId));
    }

    /**
     * Runs the pipeline on a background (virtual) thread — must be called
     * on a DIFFERENT bean than the one containing this method for Spring's
     * @Async proxy to actually intercept the call (self-invocation bypasses
     * the proxy entirely) — see AsyncJobService, which is exactly that
     * separate caller.
     *
     * IMPORTANT: MDC (and therefore the correlation ID — see
     * CorrelationIdFilter) is thread-local and does NOT automatically
     * carry over to this new virtual thread. AsyncJobService captures the
     * correlation ID from the calling (HTTP request) thread's MDC BEFORE
     * firing this async call, and passes it in explicitly here — without
     * that, every log line for the actual pipeline work would silently
     * lose its correlation ID, defeating the point of tracing a request
     * across threads/services.
     */
    @Async
    public CompletableFuture<Void> executeRunAsync(AnalysisRun run, String correlationId) {
        if (correlationId != null) {
            MDC.put(CorrelationIdFilter.MDC_KEY, correlationId);
        }
        try {
            executeRun(run);
        } finally {
            MDC.remove(CorrelationIdFilter.MDC_KEY);
        }
        return CompletableFuture.completedFuture(null);
    }

    private MigrationPlanResult executeRun(AnalysisRun run) {
        // Lets DiscoveryTools and GroundTruthComparisonService — both
        // singleton beans, invoked indirectly via the model's own tool
        // calls — know which project THIS run is scoped to, without
        // needing a projectId parameter threaded through every tool
        // method signature. See AgentRunContext's javadoc. Cleared in the
        // finally block below regardless of success/failure, so it never
        // leaks into an unrelated later call on this same (pooled/virtual)
        // thread.
        AgentRunContext.set(run.getProjectId());
        try {
            try {
                log.info("Run {} — Step 1/4: Discovery Agent investigating the loaded codebase...", run.getId());
                String discoveryReport = discoveryAgentService.analyze();
                run.advanceTo(AnalysisRun.Step.ARCHITECTURE);
                analysisRunRepository.save(run);

                log.info("Run {} — Step 2/4: Architecture Agent proposing target design...", run.getId());
                String architectureProposal = architectureAgentService.proposeArchitecture(discoveryReport);
                run.advanceTo(AnalysisRun.Step.RISK);
                analysisRunRepository.save(run);

                log.info("Run {} — Step 3/4: Risk Agent assessing migration risk...", run.getId());
                String riskAssessment = riskAgentService.assessRisk(discoveryReport);
                run.advanceTo(AnalysisRun.Step.COMPARISON);
                analysisRunRepository.save(run);

                log.info("Run {} — Step 4/4: Comparing against ground truth...", run.getId());
                String comparison = groundTruthComparisonService.compare(discoveryReport, riskAssessment);

                run.complete(discoveryReport, architectureProposal, riskAssessment, comparison);
                analysisRunRepository.save(run);

                log.info("Run {} done.", run.getId());
                return new MigrationPlanResult(run.getId(), discoveryReport, architectureProposal, riskAssessment, comparison);

            } catch (RuntimeException e) {
                run.fail();
                analysisRunRepository.save(run);
                log.error("Run {} failed: {}", run.getId(), e.getMessage(), e);
                throw e;
            }
        } finally {
            AgentRunContext.clear();
        }
    }

    private UUID findCurrentProjectId() {
        List<Project> projects = projectRepository.findAllByOrderByCreatedAtDesc();
        if (projects.isEmpty()) {
            throw new IllegalStateException("No project has been loaded yet — call rag-module's " +
                    "POST /api/rag/upload/load-example or /api/rag/upload/source first.");
        }
        return projects.get(0).getId();
    }

    private UUID validateProjectExists(UUID projectId) {
        if (!projectRepository.existsById(projectId)) {
            throw new IllegalArgumentException("No project found with id " + projectId +
                    " — check GET /api/rag/projects for valid project IDs.");
        }
        return projectId;
    }

    public record MigrationPlanResult(
            UUID runId,
            String discoveryReport,
            String architectureProposal,
            String riskAssessment,
            String groundTruthComparison
    ) {}
}
