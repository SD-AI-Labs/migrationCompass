package com.migrationadvisor.report.model;

import java.util.List;

/**
 * The structured output schema this module extracts from the agent
 * pipeline's free-text reports. Spring AI's BeanOutputConverter (via
 * ChatClient.entity(...)) generates a JSON schema from this record
 * automatically and instructs the model to conform to it — see
 * StructuredReportService for where that actually happens.
 */
public record MigrationReport(
        String systemName,
        String executiveSummary,
        TargetArchitecture targetArchitecture,
        List<ServiceRiskAssessment> serviceRisks,
        List<MigrationPhase> phasedPlan
) {

    public record TargetArchitecture(
            String migrationApproach,   // e.g. "Strangler fig pattern, service-by-service"
            List<String> proposedServices,
            List<String> keyTechnologyChoices
    ) {}

    public record ServiceRiskAssessment(
            String serviceName,
            String riskLevel,           // HIGH, MEDIUM, or LOW
            List<String> riskFactors,
            String recommendation
    ) {}

    public record MigrationPhase(
            int phaseNumber,
            String title,
            List<String> servicesInvolved,
            String rationale
    ) {}
}
