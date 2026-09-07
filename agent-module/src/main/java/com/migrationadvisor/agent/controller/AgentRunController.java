package com.migrationadvisor.agent.controller;

import com.migrationadvisor.persistence.entity.AnalysisRun;
import com.migrationadvisor.persistence.repository.AnalysisRunRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Read-only history of past pipeline runs — permanent regardless of
 * whether the run's source project's vector embeddings still exist (see
 * MigrationPlanningOrchestrator's javadoc). This is what the GUI's Reports
 * and Agent Pipeline tabs call for run history.
 */
@RestController
@RequestMapping("/api/agent/runs")
public class AgentRunController {

    private final AnalysisRunRepository analysisRunRepository;

    public AgentRunController(AnalysisRunRepository analysisRunRepository) {
        this.analysisRunRepository = analysisRunRepository;
    }

    /**
     * projectId is OPTIONAL — pass it to see only runs for a specific
     * project (e.g. the Agent Pipeline tab's "past runs for this project"
     * list); omit it to see every run across every project (the Reports
     * tab's full history view).
     */
    @GetMapping
    public List<AnalysisRun> listRuns(@RequestParam(value = "projectId", required = false) UUID projectId) {
        return projectId != null
                ? analysisRunRepository.findByProjectIdOrderByStartedAtDesc(projectId)
                : analysisRunRepository.findAllByOrderByStartedAtDesc();
    }

    @GetMapping("/{id}")
    public ResponseEntity<AnalysisRun> getRun(@PathVariable UUID id) {
        return analysisRunRepository.findById(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
