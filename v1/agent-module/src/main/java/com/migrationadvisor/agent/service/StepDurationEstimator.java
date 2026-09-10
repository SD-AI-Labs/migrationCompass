package com.migrationadvisor.agent.service;

import com.migrationadvisor.persistence.entity.AnalysisRun;
import com.migrationadvisor.persistence.repository.AnalysisRunRepository;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Estimates remaining time for an in-progress run using the ACTUAL average
 * duration of each step across previously completed runs — not a
 * hardcoded guess. Falls back to a reasonable static default only when no
 * completed runs exist yet (i.e. this is the very first run ever).
 */
@Service
public class StepDurationEstimator {

    // Used only when there's no history yet to compute real averages from.
    private static final Map<AnalysisRun.Step, Duration> DEFAULT_ESTIMATES = Map.of(
            AnalysisRun.Step.DISCOVERY, Duration.ofSeconds(90),
            AnalysisRun.Step.ARCHITECTURE, Duration.ofSeconds(45),
            AnalysisRun.Step.RISK, Duration.ofSeconds(90),
            AnalysisRun.Step.COMPARISON, Duration.ofSeconds(60)
    );

    private final AnalysisRunRepository analysisRunRepository;

    public StepDurationEstimator(AnalysisRunRepository analysisRunRepository) {
        this.analysisRunRepository = analysisRunRepository;
    }

    /**
     * Estimated seconds remaining for the given in-progress run, or null
     * if the run isn't RUNNING (nothing to estimate).
     */
    public Long estimateRemainingSeconds(AnalysisRun run) {
        if (run.getStatus() != AnalysisRun.Status.RUNNING) {
            return null;
        }

        // If stepStartedAt is null (old run or data integrity issue),
        // can't estimate remaining time — return null.
        if (run.getStepStartedAt() == null) {
            return null;
        }

        // If currentStep is null, can't estimate (corrupted data)
        if (run.getCurrentStep() == null) {
            return null;
        }

        Map<AnalysisRun.Step, Duration> averages = computeHistoricalAverages();

        Duration remaining = Duration.ZERO;
        Duration elapsedInCurrentStep = Duration.between(run.getStepStartedAt(), Instant.now());

        // Time left in the CURRENT step: average duration minus what's
        // already elapsed, floored at zero (in case this run is already
        // running longer than average).
        Duration currentStepAvg = averages.getOrDefault(run.getCurrentStep(), Duration.ZERO);
        Duration currentStepRemaining = currentStepAvg.minus(elapsedInCurrentStep);
        if (!currentStepRemaining.isNegative()) {
            remaining = remaining.plus(currentStepRemaining);
        }

        // Plus the full average duration of every step still to come.
        for (AnalysisRun.Step step : stepsAfter(run.getCurrentStep())) {
            remaining = remaining.plus(averages.getOrDefault(step, Duration.ZERO));
        }

        return remaining.getSeconds();
    }

    private Map<AnalysisRun.Step, Duration> computeHistoricalAverages() {
        List<AnalysisRun> completed = analysisRunRepository.findByStatus(AnalysisRun.Status.COMPLETE);
        if (completed.isEmpty()) {
            return DEFAULT_ESTIMATES;
        }

        Duration avgDiscovery = average(completed, r -> durationBetween(r.getStartedAt(), r.getDiscoveryCompletedAt()));
        Duration avgArchitecture = average(completed, r -> durationBetween(r.getDiscoveryCompletedAt(), r.getArchitectureCompletedAt()));
        Duration avgRisk = average(completed, r -> durationBetween(r.getArchitectureCompletedAt(), r.getRiskCompletedAt()));
        Duration avgComparison = average(completed, r -> durationBetween(r.getRiskCompletedAt(), r.getCompletedAt()));

        return Map.of(
                AnalysisRun.Step.DISCOVERY, orDefault(avgDiscovery, AnalysisRun.Step.DISCOVERY),
                AnalysisRun.Step.ARCHITECTURE, orDefault(avgArchitecture, AnalysisRun.Step.ARCHITECTURE),
                AnalysisRun.Step.RISK, orDefault(avgRisk, AnalysisRun.Step.RISK),
                AnalysisRun.Step.COMPARISON, orDefault(avgComparison, AnalysisRun.Step.COMPARISON)
        );
    }

    private Duration durationBetween(Instant start, Instant end) {
        if (start == null || end == null) return null;
        return Duration.between(start, end);
    }

    private Duration average(List<AnalysisRun> runs, java.util.function.Function<AnalysisRun, Duration> extractor) {
        List<Duration> durations = runs.stream().map(extractor).filter(java.util.Objects::nonNull).toList();
        if (durations.isEmpty()) return null;
        long totalSeconds = durations.stream().mapToLong(Duration::getSeconds).sum();
        return Duration.ofSeconds(totalSeconds / durations.size());
    }

    private Duration orDefault(Duration computed, AnalysisRun.Step step) {
        return computed != null ? computed : DEFAULT_ESTIMATES.get(step);
    }

    private List<AnalysisRun.Step> stepsAfter(AnalysisRun.Step current) {
        List<AnalysisRun.Step> ordered = List.of(
                AnalysisRun.Step.DISCOVERY, AnalysisRun.Step.ARCHITECTURE,
                AnalysisRun.Step.RISK, AnalysisRun.Step.COMPARISON);
        int idx = ordered.indexOf(current);
        return idx < 0 ? List.of() : ordered.subList(idx + 1, ordered.size());
    }
}
