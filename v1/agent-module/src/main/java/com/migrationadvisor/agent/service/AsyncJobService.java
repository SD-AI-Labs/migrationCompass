package com.migrationadvisor.agent.service;

import com.migrationadvisor.agent.orchestrator.MigrationPlanningOrchestrator;
import com.migrationadvisor.common.logging.CorrelationIdFilter;
import com.migrationadvisor.persistence.entity.AnalysisRun;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * Kicks off an async pipeline run and returns immediately with the run's
 * ID. Deliberately a SEPARATE bean from MigrationPlanningOrchestrator —
 * Spring's @Async only works through its AOP proxy, which is bypassed
 * entirely if a method calls another @Async method on itself
 * ("self-invocation"). Calling orchestrator.executeRunAsync(...) from a
 * different bean (this one) goes through the proxy correctly.
 */
@Service
public class AsyncJobService {

    private final MigrationPlanningOrchestrator orchestrator;

    public AsyncJobService(MigrationPlanningOrchestrator orchestrator) {
        this.orchestrator = orchestrator;
    }

    /** Returns immediately — the actual pipeline work continues on a background thread, against the most-recently-uploaded project. */
    public UUID startJob() {
        return startJob(null);
    }

    /**
     * Returns immediately — the actual pipeline work continues on a
     * background thread, against a SPECIFIC project. projectId may be
     * null to fall back to the most-recently-uploaded project (unchanged
     * default behavior).
     */
    public UUID startJob(UUID projectId) {
        // Captured HERE, on the calling (HTTP request) thread, where MDC
        // still has the correlation ID from CorrelationIdFilter — the
        // async execution runs on a brand-new thread with empty MDC, so
        // this needs to be passed through explicitly rather than assumed
        // to carry over automatically. See executeRunAsync's javadoc.
        String correlationId = MDC.get(CorrelationIdFilter.MDC_KEY);

        AnalysisRun run = orchestrator.createRun(projectId);
        orchestrator.executeRunAsync(run, correlationId); // fire-and-forget from this caller's perspective
        return run.getId();
    }
}

