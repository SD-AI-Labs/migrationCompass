package com.migrationadvisor.rag.ingestion;

import com.migrationadvisor.persistence.entity.Project;

/**
 * Thrown by DocumentIngestionService.ingestUploadedZip when the uploaded
 * zip's bytes exactly match an already-ingested UPLOAD project's hash and
 * the caller didn't pass override=true. Carries the EXISTING project so
 * the controller can tell the person which project this collided with.
 */
public class DuplicateProjectException extends RuntimeException {

    private final Project existingProject;

    public DuplicateProjectException(Project existingProject) {
        super("This zip's contents exactly match an already-uploaded project: '" + existingProject.getName() +
                "' (id=" + existingProject.getId() + ", uploaded " + existingProject.getCreatedAt() + "). " +
                "If some files were actually updated, this shouldn't happen — a real change produces a different " +
                "hash. If you intend to re-ingest it anyway (e.g. as a fresh duplicate for testing), retry with " +
                "override=true.");
        this.existingProject = existingProject;
    }

    public Project getExistingProject() {
        return existingProject;
    }
}
