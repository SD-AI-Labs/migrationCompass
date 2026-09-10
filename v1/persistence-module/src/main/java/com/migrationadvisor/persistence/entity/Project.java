package com.migrationadvisor.persistence.entity;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * Represents a codebase that was loaded for analysis — either the bundled
 * OrderVault example, or a real project uploaded as a zip. Every ingestion
 * (see rag-module's DocumentIngestionService) creates a new Project row.
 * Every project's chunks coexist permanently in the same vector table,
 * tagged by project_id — nothing gets truncated on a new upload. "The
 * active project" for an unscoped request is simply whichever row here is
 * most recently created; any request can instead target a SPECIFIC
 * project by id (see ActiveProjectResolver in rag-module).
 */
@Entity
@Table(name = "projects")
public class Project {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private SourceType sourceType;

    private int fileCount;
    private int chunkCount;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    /**
     * SHA-256 hex digest of the raw uploaded zip's bytes — UPLOAD projects
     * only (null for the EXAMPLE project, which is meant to be freely
     * reloadable). Used by DocumentIngestionService to detect "you just
     * uploaded the exact same zip again" before re-ingesting, so an
     * accidental duplicate upload doesn't silently create a redundant
     * project with duplicate embeddings. A genuinely updated project
     * (even one changed file) naturally produces a different hash, so
     * this never blocks a real new version — only byte-for-byte repeats.
     */
    @Column(name = "source_hash")
    private String sourceHash;

    protected Project() {
        // JPA requires a no-arg constructor
    }

    public Project(String name, SourceType sourceType, int fileCount, int chunkCount) {
        this.name = name;
        this.sourceType = sourceType;
        this.fileCount = fileCount;
        this.chunkCount = chunkCount;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public SourceType getSourceType() { return sourceType; }
    public int getFileCount() { return fileCount; }
    public int getChunkCount() { return chunkCount; }
    public Instant getCreatedAt() { return createdAt; }
    public String getSourceHash() { return sourceHash; }
    public void setSourceHash(String sourceHash) { this.sourceHash = sourceHash; }

    public enum SourceType { EXAMPLE, UPLOAD }
}
