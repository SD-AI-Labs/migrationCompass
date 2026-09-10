package com.migrationadvisor.agent.service;

import com.migrationadvisor.agent.orchestrator.AgentRunContext;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.UUID;

/**
 * Compares the Discovery and Risk Agents' generated output against
 * whatever "grounding" text is currently active in rag-module — uploaded
 * via POST /api/rag/upload/grounding, or auto-populated by
 * POST /api/rag/upload/load-example for the bundled OrderVault example.
 *
 * Fetches grounding via HTTP (GET /api/rag/grounding) rather than reading
 * a local filesystem path — this keeps agent-module fully decoupled from
 * WHERE or HOW grounding docs are stored, consistent with how
 * DiscoveryTools already composes rag-module for RAG queries. If no
 * grounding has been uploaded for the current project, comparison is
 * skipped gracefully rather than failing — grounding is optional.
 *
 * DELIBERATELY does NOT get the same self-critique/refinement loop as
 * Discovery, Architecture, and Risk. Those three are GENERATIVE steps
 * producing a report from scratch, where a self-review genuinely catches
 * gaps in coverage. This step's entire job is already "critique the AI's
 * output honestly" — layering a critique-of-the-critique on top mostly
 * just adds cost without a comparable quality gain, and risks the
 * comparison agent second-guessing its own honest assessment into
 * something softer. If this ever needs the same treatment, the sharper
 * tool would be a genuinely independent second evaluator model checking
 * for evaluator bias, not a self-review by the same agent.
 */
@Service
public class GroundTruthComparisonService {

    private final ChatClient comparisonChatClient;
    private final RestClient ragServiceRestClient;

    public GroundTruthComparisonService(
            // Reuses the plain, tool-less architectureChatClient bean for
            // this comparison — no separate bean needed since this task
            // also just reasons over provided text with no tools required.
            // Qualifier is REQUIRED here: with 3 ChatClient beans defined
            // in AgentChatClientsConfig, an unqualified injection would
            // fail with an ambiguous-bean error at startup.
            @Qualifier("architectureChatClient") ChatClient comparisonChatClient,
            @Qualifier("ragServiceRestClient") RestClient ragServiceRestClient) {
        this.comparisonChatClient = comparisonChatClient;
        this.ragServiceRestClient = ragServiceRestClient;
    }

    public String compare(String discoveryReport, String riskReport) {
        String groundTruth = fetchGroundingText();
        if (groundTruth == null) {
            return "No grounding text is currently available for this project, so comparison " +
                    "was skipped. Grounding is optional — upload it via " +
                    "POST /api/rag/upload/grounding (or /api/rag/upload/load-example for the " +
                    "bundled OrderVault example) if you want the pipeline's output scored " +
                    "against a hand-written reference.";
        }

        return comparisonChatClient.prompt()
                .system("""
                        You are an evaluator comparing an AI migration-planning pipeline's
                        output against a hand-written expert analysis of the same system
                        (the "ground truth"). Be specific and honest: call out what the
                        AI-generated reports got right, what they missed, and anything they
                        got wrong or overstated compared to the ground truth. This
                        evaluation is for demonstrating the AI pipeline's real accuracy, so
                        don't soften genuine gaps.
                        """)
                .user("""
                        GROUND TRUTH (hand-written expert analysis):
                        ---
                        %s
                        ---

                        AI-GENERATED DISCOVERY REPORT:
                        ---
                        %s
                        ---

                        AI-GENERATED RISK ASSESSMENT:
                        ---
                        %s
                        ---

                        Compare the AI-generated reports against the ground truth. Cover:
                        1. What the AI correctly identified (be specific — cite the matching points)
                        2. What the AI missed entirely
                        3. Anything the AI got wrong or stated with unwarranted confidence
                        4. An overall accuracy assessment
                        """.formatted(groundTruth, discoveryReport, riskReport))
                .call()
                .content();
    }

    private String fetchGroundingText() {
        try {
            UUID projectId = AgentRunContext.get();
            String uri = projectId != null ? "/api/rag/grounding?projectId=" + projectId : "/api/rag/grounding";
            GroundingResponse response = ragServiceRestClient.get()
                    .uri(uri)
                    .retrieve()
                    .body(GroundingResponse.class);
            return (response != null && response.available()) ? response.text() : null;
        } catch (RestClientException e) {
            System.err.println("[GroundTruthComparison] Could not reach rag-module for grounding text: " + e.getMessage());
            return null;
        }
    }

    private record GroundingResponse(boolean available, String text) {}
}
