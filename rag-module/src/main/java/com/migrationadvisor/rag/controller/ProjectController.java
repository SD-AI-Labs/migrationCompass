package com.migrationadvisor.rag.controller;

import com.migrationadvisor.persistence.entity.Project;
import com.migrationadvisor.persistence.repository.ProjectRepository;
import com.migrationadvisor.rag.grounding.GroundingStore;
import com.migrationadvisor.rag.ingestion.DocumentIngestionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Project history — every project ever loaded (example or uploaded), most
 * recent first. All listed projects' embeddings remain genuinely
 * searchable in the vector store (see DocumentIngestionService's
 * javadoc), and any of them can be targeted explicitly via the
 * projectId param on /api/rag/ask, /api/agent/analyze, etc. — this
 * endpoint is what populates the GUI's project picker and history view.
 */
@RestController
@RequestMapping("/api/rag/projects")
public class ProjectController {

    private final ProjectRepository projectRepository;
    private final DocumentIngestionService documentIngestionService;
    private final GroundingStore groundingStore;

    public ProjectController(
            ProjectRepository projectRepository,
            DocumentIngestionService documentIngestionService,
            GroundingStore groundingStore) {
        this.projectRepository = projectRepository;
        this.documentIngestionService = documentIngestionService;
        this.groundingStore = groundingStore;
    }

    @GetMapping
    public List<Project> listProjects() {
        return projectRepository.findAllByOrderByCreatedAtDesc();
    }

    /**
     * Permanently removes a project: its vector store chunks and its
     * Project row. Does NOT delete any AnalysisRun history for this
     * project in agent-module — past run results remain viewable in the
     * Reports tab even after their source project is gone, same as a
     * completed build log outliving the branch it was built from.
     *
     * Example:
     *   curl -X DELETE localhost:8082/api/rag/projects/{projectId}
     */
    @DeleteMapping("/{projectId}")
    public ResponseEntity<Void> deleteProject(@PathVariable UUID projectId) {
        documentIngestionService.deleteProject(projectId);
        groundingStore.clear(projectId);
        return ResponseEntity.noContent().build();
    }
}
