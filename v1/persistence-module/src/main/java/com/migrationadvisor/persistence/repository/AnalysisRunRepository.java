package com.migrationadvisor.persistence.repository;

import com.migrationadvisor.persistence.entity.AnalysisRun;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface AnalysisRunRepository extends JpaRepository<AnalysisRun, UUID> {

    List<AnalysisRun> findAllByOrderByStartedAtDesc();

    List<AnalysisRun> findByProjectIdOrderByStartedAtDesc(UUID projectId);

    /** Used by StepDurationEstimator to compute historical average step durations. */
    List<AnalysisRun> findByStatus(AnalysisRun.Status status);

    /**
     * Latest COMPLETE run for a given project, if any — used by
     * structured-output-module's FullPipelineReportService to reuse an
     * existing run's saved text (and, if already attached, its cached
     * structured JSON) instead of re-running the whole agent pipeline
     * every time a report is requested for a project that's already been
     * analyzed.
     */
    Optional<AnalysisRun> findFirstByProjectIdAndStatusOrderByStartedAtDesc(UUID projectId, AnalysisRun.Status status);
}
