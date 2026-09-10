package com.migrationadvisor.agent.orchestrator;

import java.util.UUID;

/**
 * Thread-scoped holder for "which project is the currently executing
 * AnalysisRun about" — lets DiscoveryTools and GroundTruthComparisonService
 * (both singleton beans with no direct visibility into the AnalysisRun
 * object) know which project's rag-module data to query, now that a run
 * can target any previously uploaded project rather than always the
 * most-recent one. A projectId can't be threaded through as a normal
 * method parameter here because DiscoveryTools' method is invoked by the
 * model itself as a tool call — its parameters are whatever the LLM
 * supplies, not the caller.
 *
 * Same rationale/shape as MDC's correlation-id pattern used elsewhere in
 * this project (see CorrelationIdFilter / executeRunAsync's javadoc): set
 * once at the start of a run's execution, read by whatever code needs it
 * during that run, cleared in a finally block. Simpler than the MDC case
 * though — MDC has to be explicitly re-propagated across the async
 * executor's thread boundary (see executeRunAsync), but executeRun()
 * always runs a run's ENTIRE step sequence on a single thread, so this
 * context is set once and cleared once, entirely within that one thread's
 * lifetime.
 */
public final class AgentRunContext {

    private static final ThreadLocal<UUID> CURRENT_PROJECT_ID = new ThreadLocal<>();

    private AgentRunContext() {
    }

    public static void set(UUID projectId) {
        CURRENT_PROJECT_ID.set(projectId);
    }

    /** Null if no run is currently executing on this thread (e.g. a standalone step endpoint call). */
    public static UUID get() {
        return CURRENT_PROJECT_ID.get();
    }

    public static void clear() {
        CURRENT_PROJECT_ID.remove();
    }
}
