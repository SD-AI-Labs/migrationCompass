package com.migrationadvisor.rag.ingestion;

import com.migrationadvisor.persistence.entity.Project;
import com.migrationadvisor.persistence.repository.ProjectRepository;
import org.springframework.ai.document.Document;
import org.springframework.ai.transformer.splitter.TokenTextSplitter;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.beans.factory.annotation.Value;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Handles three distinct ingestion paths, all funneling into the same
 * (Postgres-backed) VectorStore:
 *
 * 1. {@link #ingestExampleProject()} — re-loads the bundled OrderVault test
 *    data (source-code/, api-specs/, operational-data/, database/, logs/
 *    — NOT ground-truth/).
 * 2. {@link #ingestUploadedZip(MultipartFile, boolean)} — indexes an
 *    arbitrary uploaded codebase. No folder-name filtering — every file
 *    with an allowed extension gets indexed. Detects byte-for-byte
 *    duplicate re-uploads (see DuplicateProjectException).
 * 3. {@link #ingestLogFiles(MultipartFile[])} — indexes application log
 *    files for operational/observability analysis, tagged with
 *    documentType=log metadata. Always additive to whichever project is
 *    currently active (see storage model below) — logs supplement a
 *    project rather than being a project of their own.
 *
 * STORAGE MODEL: every project's chunks are tagged with a project_id
 * metadata field and coexist in the SAME vector table — uploading a new
 * project does NOT delete any earlier project's data (this used to
 * truncate-and-replace in an earlier iteration; that's no longer how this
 * works). "The active project" — the one RagQueryService actually
 * searches against for a given /api/rag/ask call — is simply whichever
 * Project row is most recently created; queries are scoped to it via a
 * project_id filter at query time (see RagQueryService). Switching back
 * to an OLDER project's data as "active" isn't exposed via an endpoint
 * yet (would just mean re-ingesting it, which creates a new, later
 * Project row) — a natural next step, not implemented here.
 */
@Service
public class DocumentIngestionService {

    private static final Logger log = LoggerFactory.getLogger(DocumentIngestionService.class);

    private static final Set<String> ALLOWED_EXTENSIONS =
            Set.of("java", "xml", "yaml", "yml", "json", "sql", "md", "py", "js", "ts", "go", "rb", "cs", "kt", "log", "txt");

    private static final Set<String> LOG_ALLOWED_EXTENSIONS =
            Set.of("log", "txt", "out");

    /**
     * File types where a naive fixed-size chunk boundary is most likely to
     * land in the middle of a function/method/class body — used to give
     * code files a larger chunk size than prose (see chunkDocuments()).
     * NOTE: this is a chunk-SIZE tuning, not true syntax-aware chunking —
     * a real fix would parse each language's AST and split on
     * function/class boundaries exactly. That's meaningfully more
     * engineering (a parser per language) for a marginal further gain
     * over a larger token budget, so it's tracked as a roadmap item
     * rather than implemented here.
     */
    private static final Set<String> CODE_EXTENSIONS =
            Set.of("java", "py", "js", "ts", "go", "rb", "cs", "kt");

    private static final Set<String> ORDERVAULT_INCLUDED_TOP_LEVEL_DIRS =
            Set.of("source-code", "api-specs", "operational-data", "database", "logs");

    private final VectorStore vectorStore;
    private final ProjectRepository projectRepository;
    private final String exampleProjectPath;
    private final List<String> ingestedSourcePaths = new ArrayList<>();

    public DocumentIngestionService(
            VectorStore vectorStore,
            ProjectRepository projectRepository,
            @Value("${ordervault.rag.example-project-path:../test-data/mock-legacy-app}") String exampleProjectPath) {
        this.vectorStore = vectorStore;
        this.projectRepository = projectRepository;
        this.exampleProjectPath = exampleProjectPath;
    }

    /** Exposed for GET /api/rag/sources. */
    public synchronized List<String> getIngestedSourcePaths() {
        return List.copyOf(ingestedSourcePaths);
    }

    public IngestionResult ingestExampleProject() {
        Path basePath = Paths.get(exampleProjectPath).toAbsolutePath().normalize();
        log.info("Loading bundled OrderVault example from: {}", basePath);

        if (!Files.isDirectory(basePath)) {
            throw new IllegalStateException("Example project path does not exist: " + basePath +
                    " — check 'ordervault.rag.example-project-path', or run from the rag-module directory.");
        }

        List<Document> documents = loadDocuments(basePath, path -> isInIncludedTopLevelDir(basePath, path));

        long groundTruthLeaks = documents.stream()
                .map(d -> String.valueOf(d.getMetadata().get("source")))
                .filter(p -> p.contains("ground-truth"))
                .count();
        if (groundTruthLeaks > 0) {
            log.warn("*** {} ground-truth file(s) were about to be ingested — this should never happen. ***", groundTruthLeaks);
        } else {
            log.info("ground-truth exclusion check passed: 0 files from ground-truth/.");
        }

        return ingestAndReplace(documents, "OrderVault (example)", Project.SourceType.EXAMPLE, null);
    }

    /**
     * override=false (default): if this zip's bytes exactly match an
     * already-uploaded project, throws DuplicateProjectException instead
     * of re-ingesting — see that exception's javadoc and Project.sourceHash.
     * override=true: skips the check and ingests unconditionally.
     */
    public IngestionResult ingestUploadedZip(MultipartFile zipFile, boolean override) throws IOException {
        byte[] zipBytes = zipFile.getBytes();
        String hash = sha256Hex(zipBytes);

        if (!override) {
            Optional<Project> existing = projectRepository
                    .findFirstBySourceHashAndSourceTypeOrderByCreatedAtDesc(hash, Project.SourceType.UPLOAD);
            if (existing.isPresent()) {
                throw new DuplicateProjectException(existing.get());
            }
        }

        Path tempDir = Files.createTempDirectory("uploaded-project-");
        try {
            log.info("Extracting uploaded zip to: {}", tempDir);
            ZipExtractor.extract(zipFile, tempDir);

            List<Document> documents = loadDocuments(tempDir, path -> true);
            String projectName = zipFile.getOriginalFilename() != null ? zipFile.getOriginalFilename() : "uploaded-project";
            return ingestAndReplace(documents, projectName, Project.SourceType.UPLOAD, hash);
        } finally {
            deleteRecursively(tempDir);
        }
    }

    private static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is guaranteed available on every JVM — this is unreachable.
            throw new IllegalStateException(e);
        }
    }

    /**
     * Removes a project entirely: its vector store chunks (via a
     * project_id filter delete — no ID bookkeeping needed) and its
     * Project row. Does NOT touch grounding text (a separate concern
     * owned by GroundingStore, cleared by the caller) or any AnalysisRun
     * history for this project — those remain as a historical record even
     * after the source project is removed, same as deleting a git repo
     * doesn't erase your commit log.
     */
    public void deleteProject(UUID projectId) {
        if (!projectRepository.existsById(projectId)) {
            throw new IllegalArgumentException("No project found with id " + projectId);
        }
        vectorStore.delete("project_id == '" + projectId + "'");
        projectRepository.deleteById(projectId);
        log.info("Deleted project {} — vector store chunks removed, Project row removed.", projectId);
    }

    /**
     * Ingests log files for the CURRENTLY loaded project — additive, does
     * NOT truncate existing source-code embeddings (see class javadoc).
     * Requires a project to already be loaded (via ingestExampleProject or
     * ingestUploadedZip) — logs are evidence ABOUT a specific system, they
     * can't stand alone.
     */
    public IngestionResult ingestLogFiles(MultipartFile[] logFiles) throws IOException {
        UUID projectId = findCurrentProjectId();

        List<Document> documents = new ArrayList<>();
        for (MultipartFile file : logFiles) {
            if (file.isEmpty()) continue;
            String fileName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "unnamed.log";
            if (!hasLogExtension(fileName)) {
                log.warn("Skipping upload with unrecognized log extension: {}", fileName);
                continue;
            }
            String content = new String(file.getBytes(), java.nio.charset.StandardCharsets.UTF_8);
            documents.add(new Document(content, Map.of(
                    "source", fileName,
                    "fileName", fileName,
                    "documentType", "log")));
        }

        if (documents.isEmpty()) {
            throw new IllegalArgumentException("No valid log files in upload (expected .log, .txt, or .out)");
        }

        List<Document> chunks = chunkDocuments(documents);
        List<Document> taggedChunks = chunks.stream()
                .map(c -> new Document(c.getText(), mergeMetadata(c.getMetadata(), projectId)))
                .toList();

        log.info("Ingesting {} log file(s) ({} chunks) for project {} — additive, existing data preserved",
                documents.size(), chunks.size(), projectId);
        vectorStore.add(taggedChunks);

        synchronized (this) {
            documents.forEach(doc -> ingestedSourcePaths.add("[log] " + doc.getMetadata().get("source")));
        }

        log.info("Done. {} log chunks indexed and added to project {}.", chunks.size(), projectId);
        return new IngestionResult(projectId, documents.size(), chunks.size());
    }

    private boolean hasLogExtension(String fileName) {
        int dotIndex = fileName.lastIndexOf('.');
        if (dotIndex < 0) return false;
        return LOG_ALLOWED_EXTENSIONS.contains(fileName.substring(dotIndex + 1).toLowerCase());
    }

    /**
     * Splits documents into chunks, using a LARGER chunk size (in tokens)
     * for source code files than for prose (markdown specs, JSON, logs).
     * Rationale: a chunk boundary landing mid-function destroys local
     * coherence far more than the same boundary landing mid-paragraph in
     * prose — a function needs its own signature/body/logic together to
     * be useful context, whereas prose degrades more gracefully when
     * split. This doesn't parse code syntactically (see CODE_EXTENSIONS'
     * javadoc) — it's a size tuning that reduces, not eliminates, how
     * often a chunk boundary falls inside a function/class body.
     */
    private List<Document> chunkDocuments(List<Document> documents) {
        Map<Boolean, List<Document>> partitioned = documents.stream()
                .collect(Collectors.partitioningBy(this::isCodeSource));

        TokenTextSplitter codeSplitter = TokenTextSplitter.builder()
                .withChunkSize(1500)          // vs. the 800-token default — code needs more room per chunk
                .withMinChunkSizeChars(500)
                .build();
        TokenTextSplitter proseSplitter = new TokenTextSplitter(); // defaults are fine for markdown/specs/JSON/logs

        List<Document> chunks = new ArrayList<>();
        chunks.addAll(codeSplitter.apply(partitioned.get(true)));
        chunks.addAll(proseSplitter.apply(partitioned.get(false)));
        return chunks;
    }

    private boolean isCodeSource(Document doc) {
        String source = String.valueOf(doc.getMetadata().get("source"));
        int dotIndex = source.lastIndexOf('.');
        if (dotIndex < 0) return false;
        return CODE_EXTENSIONS.contains(source.substring(dotIndex + 1).toLowerCase());
    }

    private UUID findCurrentProjectId() {
        List<Project> projects = projectRepository.findAllByOrderByCreatedAtDesc();
        if (projects.isEmpty()) {
            throw new IllegalStateException("No project has been loaded yet — load the example project or " +
                    "upload source code first, before uploading logs.");
        }
        return projects.get(0).getId();
    }

    private IngestionResult ingestAndReplace(List<Document> documents, String projectName, Project.SourceType sourceType, String sourceHash) {
        synchronized (this) {
            ingestedSourcePaths.clear();
            documents.forEach(doc -> ingestedSourcePaths.add(String.valueOf(doc.getMetadata().get("source"))));
        }
        log.info("Loaded {} source files", documents.size());

        List<Document> chunks = chunkDocuments(documents);
        log.info("Split into {} chunks — embedding via Ollama now...", chunks.size());

        // Create the permanent Project record, so every chunk can be
        // tagged with its project_id — this metadata is what makes
        // multi-project simultaneous storage work: each project's chunks
        // coexist in the same vector table, and queries are scoped to one
        // project at a time via a metadata filter (see RagQueryService),
        // not by deleting everyone else's data.
        Project project = new Project(projectName, sourceType, documents.size(), chunks.size());
        project.setSourceHash(sourceHash);
        project = projectRepository.save(project);
        UUID projectId = project.getId();

        List<Document> taggedChunks = chunks.stream()
                .map(c -> new Document(c.getText(), mergeMetadata(c.getMetadata(), projectId)))
                .toList();

        // NOTE: no truncation here anymore. Every previously ingested
        // project's chunks remain in the vector table — "the active
        // project" (see RagQueryService.findActiveProjectId) is simply
        // whichever Project row is most recently created, and queries are
        // scoped to it via a project_id filter at query time. This
        // replaces the earlier "truncate on every upload" staged design —
        // see project history/README for that earlier approach's rationale
        // if useful context, but it's no longer how this works.
        vectorStore.add(taggedChunks);

        log.info("Done. Project '{}' ({}) — {} chunks indexed (added alongside any earlier projects' data).",
                projectName, projectId, chunks.size());
        return new IngestionResult(projectId, documents.size(), chunks.size());
    }

    private Map<String, Object> mergeMetadata(Map<String, Object> existing, UUID projectId) {
        var merged = new java.util.HashMap<>(existing);
        merged.put("project_id", projectId.toString());
        return merged;
    }

    private List<Document> loadDocuments(Path basePath, java.util.function.Predicate<Path> pathFilter) {
        try (Stream<Path> paths = Files.walk(basePath)) {
            return paths
                    .filter(Files::isRegularFile)
                    .filter(pathFilter)
                    .filter(this::hasAllowedExtension)
                    .map(path -> readAsDocument(basePath, path))
                    .filter(java.util.Objects::nonNull)
                    .toList();
        } catch (IOException e) {
            throw new RuntimeException("Failed to walk source directory: " + basePath, e);
        }
    }

    private boolean isInIncludedTopLevelDir(Path basePath, Path path) {
        Path relative = basePath.relativize(path);
        if (relative.getNameCount() == 0) return false;
        return ORDERVAULT_INCLUDED_TOP_LEVEL_DIRS.contains(relative.getName(0).toString());
    }

    private boolean hasAllowedExtension(Path path) {
        String fileName = path.getFileName().toString();
        int dotIndex = fileName.lastIndexOf('.');
        if (dotIndex < 0) return false;
        return ALLOWED_EXTENSIONS.contains(fileName.substring(dotIndex + 1).toLowerCase());
    }

    private Document readAsDocument(Path basePath, Path filePath) {
        try {
            String content = Files.readString(filePath);
            String relativePath = basePath.relativize(filePath).toString();
            return new Document(content, Map.of("source", relativePath, "fileName", filePath.getFileName().toString()));
        } catch (IOException e) {
            log.warn("Skipping unreadable file: {} ({})", filePath, e.getMessage());
            return null;
        }
    }

    private void deleteRecursively(Path dir) {
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.delete(p);
                } catch (IOException ignored) {
                }
            });
        } catch (IOException ignored) {
        }
    }

    public record IngestionResult(UUID projectId, int filesIngested, int chunksIndexed) {}
}
