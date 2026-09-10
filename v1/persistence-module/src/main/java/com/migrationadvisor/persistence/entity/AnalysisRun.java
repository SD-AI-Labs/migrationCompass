package com.migrationadvisor.persistence.entity;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * Represents one execution of the multi-agent migration-planning pipeline
 * (see agent-module's MigrationPlanningOrchestrator), tied to whichever
 * Project was active when the run started. Stores the full text of all
 * four pipeline outputs (discovery/architecture/risk/comparison) plus,
 * optionally, the structured JSON report generated afterward by
 * structured-output-module.
 *
 * Also tracks step-level progress (currentStep, stepStartedAt, and each
 * step's completion timestamp) — this is what makes async progress
 * polling possible: a client can read this row's current state directly
 * from Postgres regardless of which thread/process is actually doing the
 * work. Step completion timestamps also feed StepDurationEstimator's
 * historical-average time estimates for IN-PROGRESS runs.
 *
 * This is permanent history — unlike a Project's vector embeddings (which
 * get truncated on the next upload), an AnalysisRun's text is never
 * deleted, so old runs remain fully readable even after their source
 * project's embeddings are gone. This is exactly what backs the "report
 * history" GUI tab planned next.
 */
@Entity
@Table(name = "analysis_runs")
public class AnalysisRun {

    @Id
    @GeneratedValue
    private UUID id;

    @Column(nullable = false)
    private UUID projectId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Step currentStep = Step.DISCOVERY;

    @Column(nullable = false)
    private Instant stepStartedAt = Instant.now();

    private Instant discoveryCompletedAt;
    private Instant architectureCompletedAt;
    private Instant riskCompletedAt;
    // Comparison's completion is 'completedAt' below — it's also the run's overall completion.

    // NOTE: deliberately NOT @Lob. On PostgreSQL, Hibernate maps @Lob on a
    // String field to Postgres's actual Large Object type (a row in
    // pg_largeobject, referenced by an `oid` column) rather than a plain
    // `text` column. Postgres Large Objects are a transactional resource —
    // reading one via lo_open/lo_read requires an active transaction, so
    // any plain (non-@Transactional) repository read, like this project's
    // async status-polling endpoint, fails with "Large Objects may not be
    // used in auto-commit mode." @JdbcTypeCode(SqlTypes.LONGVARCHAR) tells
    // Hibernate to map this to a plain unbounded `text` column instead —
    // simple varchar semantics, no transaction required, no length cap
    // (unlike a bare String, which without an explicit length hint would
    // default to varchar(255) and silently truncate these full LLM report
    // outputs).
    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    @Column(columnDefinition = "text")
    private String discoveryReport;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    @Column(columnDefinition = "text")
    private String architectureProposal;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    @Column(columnDefinition = "text")
    private String riskAssessment;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    @Column(columnDefinition = "text")
    private String groundTruthComparison;

    /** Populated later by structured-output-module, if/when that step runs. Raw JSON text. */
    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    @Column(columnDefinition = "text")
    private String structuredReportJson;

    @Column(nullable = false)
    private Instant startedAt = Instant.now();

    private Instant completedAt;

    protected AnalysisRun() {
        // JPA requires a no-arg constructor
    }

    public AnalysisRun(UUID projectId) {
        this.projectId = projectId;
        this.status = Status.RUNNING;
        this.startedAt = Instant.now();
        this.stepStartedAt = Instant.now();
    }

    /**
     * Called by JPA after loading from database — ensures fields with
     * @Column(nullable = false) but null in DB get sensible defaults.
     * This handles data integrity issues gracefully.
     */
    @PostLoad
    private void ensureDefaults() {
        if (this.currentStep == null) {
            this.currentStep = Step.DISCOVERY;
        }
        if (this.stepStartedAt == null) {
            this.stepStartedAt = Instant.now();
        }
        if (this.startedAt == null) {
            this.startedAt = Instant.now();
        }
    }

    /**
     * Marks the CURRENT step as complete (recording its completion
     * timestamp) and moves to the next step, resetting stepStartedAt so
     * elapsed-time-in-current-step calculations stay accurate.
     */
    public void advanceTo(Step nextStep) {
        Instant now = Instant.now();
        switch (currentStep) {
            case DISCOVERY -> discoveryCompletedAt = now;
            case ARCHITECTURE -> architectureCompletedAt = now;
            case RISK -> riskCompletedAt = now;
            default -> { /* COMPARISON/DONE have no separate "next step" transition to record here */ }
        }
        this.currentStep = nextStep;
        this.stepStartedAt = now;
    }

    public void complete(String discoveryReport, String architectureProposal, String riskAssessment, String groundTruthComparison) {
        this.discoveryReport = discoveryReport;
        this.architectureProposal = architectureProposal;
        this.riskAssessment = riskAssessment;
        this.groundTruthComparison = groundTruthComparison;
        this.status = Status.COMPLETE;
        this.currentStep = Step.DONE;
        this.completedAt = Instant.now();
    }

    public void fail() {
        this.status = Status.FAILED;
        this.completedAt = Instant.now();
    }

    public void attachStructuredReport(String structuredReportJson) {
        this.structuredReportJson = structuredReportJson;
    }

    public UUID getId() { return id; }
    public UUID getProjectId() { return projectId; }
    public Status getStatus() { return status; }
    public Step getCurrentStep() { return currentStep; }
    public Instant getStepStartedAt() { return stepStartedAt; }
    public Instant getDiscoveryCompletedAt() { return discoveryCompletedAt; }
    public Instant getArchitectureCompletedAt() { return architectureCompletedAt; }
    public Instant getRiskCompletedAt() { return riskCompletedAt; }
    public String getDiscoveryReport() { return discoveryReport; }
    public String getArchitectureProposal() { return architectureProposal; }
    public String getRiskAssessment() { return riskAssessment; }
    public String getGroundTruthComparison() { return groundTruthComparison; }
    public String getStructuredReportJson() { return structuredReportJson; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getCompletedAt() { return completedAt; }

    public enum Status { RUNNING, COMPLETE, FAILED }

    public enum Step { DISCOVERY, ARCHITECTURE, RISK, COMPARISON, DONE }
}
