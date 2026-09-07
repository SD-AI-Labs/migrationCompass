package com.migrationadvisor.agent.tool;

import com.migrationadvisor.agent.orchestrator.AgentRunContext;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.UUID;

/**
 * Gives the Discovery Agent a way to query rag-module's knowledge base for
 * whichever project the currently executing AnalysisRun targets (see
 * AgentRunContext) — falls back to rag-module's own default (most recently
 * uploaded project) if called outside of a run context, e.g. via the
 * standalone POST /api/agent/discovery endpoint.
 *
 * Deliberately calls rag-module over HTTP rather than embedding a second
 * copy of the vector store here — this mirrors how a real agent would
 * compose an existing RAG service rather than duplicating it, and keeps
 * rag-module as the single source of truth for what's actually indexed.
 *
 * Requires rag-module to be running (default: localhost:8082).
 */
@Component
public class DiscoveryTools {

    private final RestClient ragServiceRestClient;

    public DiscoveryTools(RestClient ragServiceRestClient) {
        this.ragServiceRestClient = ragServiceRestClient;
    }

    @Tool(description = """
            Query the currently loaded codebase's knowledge base — its
            actual source code, API specs, database schema, and
            operational data (if provided) — to answer a specific question.
            Use this repeatedly with different focused questions to build
            up a full picture of an unfamiliar system: start with broad
            discovery questions ("what services/components exist?"), then
            follow up with specific questions about each one you find.
            """)
    public String queryKnowledgeBase(
            @ToolParam(description = "A specific, focused question about the codebase, e.g. 'What services or components exist in this codebase?' or 'What does the OrderReservation class do and what are its known issues?'")
            String question) {
        try {
            UUID projectId = AgentRunContext.get();
            RagAskResponse response = ragServiceRestClient.post()
                    .uri("/api/rag/ask")
                    .body(new RagAskRequest(question, projectId))
                    .retrieve()
                    .body(RagAskResponse.class);
            return response != null ? response.answer() : "No response from knowledge base.";
        } catch (RestClientException e) {
            return "ERROR: could not reach the knowledge base (rag-module). " +
                    "Is it running, and has a project been loaded/uploaded? Details: " + e.getMessage();
        }
    }

    private record RagAskRequest(String question, UUID projectId) {}
    private record RagAskResponse(String answer) {}
}
