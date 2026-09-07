package com.migrationadvisor.rag.controller;

import com.migrationadvisor.rag.grounding.GroundingStore;
import com.migrationadvisor.rag.ingestion.DocumentIngestionService;
import com.migrationadvisor.rag.ingestion.DuplicateProjectException;
import com.migrationadvisor.rag.project.ActiveProjectResolver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.UUID;

@RestController
@RequestMapping("/api/rag/upload")
public class UploadController {

    private static final Logger log = LoggerFactory.getLogger(UploadController.class);

    private final DocumentIngestionService documentIngestionService;
    private final GroundingStore groundingStore;
    private final ActiveProjectResolver activeProjectResolver;
    private final String exampleGroundTruthPath;

    public UploadController(
            DocumentIngestionService documentIngestionService,
            GroundingStore groundingStore,
            ActiveProjectResolver activeProjectResolver,
            @Value("${ordervault.rag.example-ground-truth-path:../test-data/mock-legacy-app/ground-truth}") String exampleGroundTruthPath) {
        this.documentIngestionService = documentIngestionService;
        this.groundingStore = groundingStore;
        this.activeProjectResolver = activeProjectResolver;
        this.exampleGroundTruthPath = exampleGroundTruthPath;
    }

    /**
     * Upload a zip of any codebase to analyze. Every previously uploaded
     * project's embeddings (and grounding docs, if any) remain intact and
     * pickable — see DocumentIngestionService's and GroundingStore's
     * javadocs — this just adds a new project and makes it the new
     * default "active" one.
     *
     * override is OPTIONAL, defaults to false — if the zip's bytes
     * exactly match an already-uploaded project, the request is rejected
     * with HTTP 409 and the existing project's info instead of silently
     * creating a redundant duplicate. Pass override=true to force
     * re-ingestion anyway. A genuinely updated project (any file changed)
     * never triggers this — only a byte-for-byte repeat does.
     *
     * Example:
     *   curl -X POST localhost:8082/api/rag/upload/source \
     *     -F "file=@/path/to/my-project.zip"
     *   curl -X POST "localhost:8082/api/rag/upload/source?override=true" \
     *     -F "file=@/path/to/my-project.zip"
     */
    @PostMapping("/source")
    public DocumentIngestionService.IngestionResult uploadSource(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "override", required = false, defaultValue = "false") boolean override) throws IOException {
        if (file.isEmpty()) {
            throw new IllegalArgumentException("Uploaded file is empty");
        }
        return documentIngestionService.ingestUploadedZip(file, override);
    }

    @ExceptionHandler(DuplicateProjectException.class)
    public ResponseEntity<DuplicateUploadResponse> handleDuplicate(DuplicateProjectException e) {
        var existing = e.getExistingProject();
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new DuplicateUploadResponse(
                true, existing.getId(), existing.getName(), existing.getCreatedAt(), e.getMessage()));
    }

    /**
     * Upload one or more grounding documents (hand-written architecture
     * notes, known-issues docs, etc.) for a project. These are NEVER
     * ingested into the searchable vector store — see GroundingStore's
     * javadoc. Used only by agent-module's Comparison step, fetched via
     * GET /api/rag/grounding.
     *
     * projectId is OPTIONAL — pass it to attach grounding to a SPECIFIC
     * previously uploaded project; omit it to target the
     * most-recently-created project (unchanged default behavior).
     *
     * Example:
     *   curl -X POST "localhost:8082/api/rag/upload/grounding?projectId=..." \
     *     -F "files=@architecture-notes.md" \
     *     -F "files=@known-issues.md"
     */
    @PostMapping("/grounding")
    public GroundingUploadResponse uploadGrounding(
            @RequestParam("files") MultipartFile[] files,
            @RequestParam(value = "projectId", required = false) UUID projectId) throws IOException {
        UUID targetProjectId = activeProjectResolver.resolve(projectId);

        StringBuilder combined = new StringBuilder();
        int count = 0;
        for (MultipartFile f : files) {
            if (f.isEmpty()) continue;
            combined.append("=== ").append(f.getOriginalFilename()).append(" ===\n");
            combined.append(new String(f.getBytes(), java.nio.charset.StandardCharsets.UTF_8));
            combined.append("\n\n");
            count++;
        }
        groundingStore.set(targetProjectId, combined.toString());
        return new GroundingUploadResponse(count, combined.length());
    }

    /**
     * Upload one or more application log files for the CURRENTLY loaded
     * project — ADDITIVE, unlike /source (does not truncate/replace
     * existing source-code embeddings). Enables the Discovery and Risk
     * agents to reason about actual runtime behavior (errors, exceptions,
     * warnings) alongside static code analysis — see
     * DocumentIngestionService.ingestLogFiles's javadoc for the full
     * rationale. Requires a project to already be loaded.
     *
     * Example:
     *   curl -X POST localhost:8082/api/rag/upload/logs \
     *     -F "files=@app-2026-08-15.log" \
     *     -F "files=@error.log"
     */
    @PostMapping("/logs")
    public DocumentIngestionService.IngestionResult uploadLogs(@RequestParam("files") MultipartFile[] files) throws IOException {
        return documentIngestionService.ingestLogFiles(files);
    }

    /**
     * Convenience: re-loads the bundled OrderVault example project AND its
     * ground-truth docs, so the whole pipeline can be tried with zero
     * setup — no zip file needed.
     *
     * Example:
     *   curl -X POST localhost:8082/api/rag/upload/load-example
     */
    @PostMapping("/load-example")
    public DocumentIngestionService.IngestionResult loadExample() throws IOException {
        DocumentIngestionService.IngestionResult result = documentIngestionService.ingestExampleProject();

        Path basePath = Paths.get(exampleGroundTruthPath).toAbsolutePath().normalize();
        Path archPath = basePath.resolve("architecture-overview.md");
        Path depPath = basePath.resolve("dependency-graph.md");
        if (Files.exists(archPath) && Files.exists(depPath)) {
            String combined = "=== architecture-overview.md ===\n" + Files.readString(archPath) +
                    "\n\n=== dependency-graph.md ===\n" + Files.readString(depPath);
            groundingStore.set(result.projectId(), combined);
        } else {
            log.warn("Example ground-truth docs not found at: {}", basePath);
        }

        return result;
    }

    public record GroundingUploadResponse(int filesReceived, int totalCharacters) {}
    public record DuplicateUploadResponse(boolean duplicate, UUID existingProjectId, String existingProjectName, Instant existingProjectCreatedAt, String message) {}
}
