package com.migrationadvisor.rag.grounding;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Holds "grounding" text — hand-written ground-truth docs (and optionally
 * operational data context) the Comparison step in agent-module evaluates
 * its own output against — keyed by project ID.
 *
 * DELIBERATELY separate from the vector store / DocumentIngestionService:
 * grounding text is never chunked, embedded, or made retrievable via RAG.
 * See test-data/mock-legacy-app/README.md (for the OrderVault example) and
 * this module's upload endpoints for the full rationale — the point of
 * grounding is to be an answer key the agents never see during their own
 * reasoning, only used afterward to score their output.
 *
 * Was previously a single global slot (one project's grounding text at a
 * time, replaced wholesale on upload) — upgraded to per-project storage
 * alongside the vector store's own move to multi-project storage (see
 * DocumentIngestionService's javadoc). Without this, selecting an OLDER
 * project for agent analysis would silently score its Comparison step
 * against whichever project's grounding docs were most recently uploaded,
 * not the project actually being analyzed. In-memory only (like before) —
 * cleared on module restart, matching every other module's ephemeral-state
 * conventions in this project.
 */
@Component
public class GroundingStore {

    private final Map<UUID, String> groundingByProject = new ConcurrentHashMap<>();

    public void set(UUID projectId, String text) {
        groundingByProject.put(projectId, text);
    }

    public void clear(UUID projectId) {
        groundingByProject.remove(projectId);
    }

    /** Null if no grounding has been uploaded/loaded for this project. */
    public String get(UUID projectId) {
        return groundingByProject.get(projectId);
    }

    public boolean isPresent(UUID projectId) {
        return groundingByProject.containsKey(projectId);
    }
}
