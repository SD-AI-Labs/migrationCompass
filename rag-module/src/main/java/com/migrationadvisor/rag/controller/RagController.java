package com.migrationadvisor.rag.controller;

import com.migrationadvisor.rag.grounding.GroundingStore;
import com.migrationadvisor.rag.ingestion.DocumentIngestionService;
import com.migrationadvisor.rag.project.ActiveProjectResolver;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.rag.retrieval.search.VectorStoreDocumentRetriever;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/rag")
public class RagController {

    private final ChatClient chatClient;
    private final DocumentIngestionService documentIngestionService;
    private final GroundingStore groundingStore;
    private final ActiveProjectResolver activeProjectResolver;

    public RagController(
            ChatClient chatClient,
            DocumentIngestionService documentIngestionService,
            GroundingStore groundingStore,
            ActiveProjectResolver activeProjectResolver) {
        this.chatClient = chatClient;
        this.documentIngestionService = documentIngestionService;
        this.groundingStore = groundingStore;
        this.activeProjectResolver = activeProjectResolver;
    }

    /**
     * Deterministic diagnostic endpoint — lists every file path that was
     * actually ingested into the vector store, straight from
     * DocumentIngestionService's own record of what it loaded. Does NOT
     * go through the LLM at all — use it to verify what's actually
     * indexed, or to spot-check a chat answer's claims.
     *
     * Example:
     *   curl localhost:8082/api/rag/sources
     */
    @GetMapping("/sources")
    public SourcesResponse sources() {
        List<String> paths = documentIngestionService.getIngestedSourcePaths();
        long groundTruthCount = paths.stream().filter(p -> p.contains("ground-truth")).count();
        return new SourcesResponse(paths.size(), groundTruthCount, paths);
    }

    /**
     * Example:
     *   curl -X POST localhost:8082/api/rag/ask \
     *     -H "Content-Type: application/json" \
     *     -d '{"question":"What does the payment integration look like?"}'
     *
     * Multiple projects' chunks can coexist in the vector store (see
     * DocumentIngestionService's javadoc) — this scopes retrieval to a
     * single project via VectorStoreDocumentRetriever's FILTER_EXPRESSION,
     * set per-request rather than fixed at ChatClient-bean-creation time.
     * Without this, a question could retrieve chunks from an unrelated
     * project.
     *
     * request.projectId() is OPTIONAL — pass it to ask a question against
     * a SPECIFIC previously uploaded project (see GET /api/rag/projects
     * for the list to pick from); omit it to fall back to the
     * most-recently-created project, same as before this parameter
     * existed.
     */
    @PostMapping("/ask")
    public AnswerResponse ask(@RequestBody QuestionRequest request) {
        UUID activeProjectId = activeProjectResolver.resolve(request.projectId());

        String answer = chatClient.prompt()
                .user(request.question())
                .advisors(a -> a.param(
                        VectorStoreDocumentRetriever.FILTER_EXPRESSION,
                        "project_id == '" + activeProjectId + "'"))
                .call()
                .content();
        return new AnswerResponse(answer);
    }

    /**
     * Fetches the currently active grounding text (uploaded via
     * POST /api/rag/upload/grounding or /api/rag/upload/load-example), if
     * any, for a project. Called by agent-module's
     * GroundTruthComparisonService instead of reading a local filesystem
     * path — keeps agent-module fully decoupled from where/how grounding
     * docs are stored.
     *
     * projectId is OPTIONAL — omit it to fall back to the
     * most-recently-created project (unchanged default behavior).
     *
     * Example:
     *   curl localhost:8082/api/rag/grounding
     *   curl "localhost:8082/api/rag/grounding?projectId=..."
     */
    @GetMapping("/grounding")
    public GroundingResponse grounding(@RequestParam(value = "projectId", required = false) UUID projectId) {
        UUID activeProjectId = activeProjectResolver.resolve(projectId);
        String text = groundingStore.get(activeProjectId);
        return new GroundingResponse(text != null, text);
    }

    public record QuestionRequest(String question, UUID projectId) {}
    public record AnswerResponse(String answer) {}
    public record SourcesResponse(int totalFiles, long groundTruthFilesFound, List<String> sourcePaths) {}
    public record GroundingResponse(boolean available, String text) {}
}
