package com.migrationadvisor.report.service;

import com.migrationadvisor.report.converter.LenientJsonOutputConverter;
import com.migrationadvisor.report.model.MigrationReport;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.stereotype.Service;

@Service
public class StructuredReportService {

    private final ChatClient chatClient;

    public StructuredReportService(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    public MigrationReport generateReport(String discoveryReport, String architectureProposal, String riskAssessment) {
        return chatClient.prompt()
                .user("""
                        Here are three reports from an AI migration-planning pipeline
                        analyzing a system that was uploaded for assessment:

                        === DISCOVERY REPORT ===
                        %s

                        === ARCHITECTURE PROPOSAL ===
                        %s

                        === RISK ASSESSMENT ===
                        %s

                        Synthesize these into a single structured migration report.
                        """.formatted(discoveryReport, architectureProposal, riskAssessment))
                .call()
                // LenientJsonOutputConverter tolerates the model wrapping its
                // JSON response in a markdown code fence, which some models
                // do despite being asked for raw JSON — see that class's
                // javadoc. Functionally equivalent to
                // .entity(MigrationReport.class) when the model behaves,
                // with graceful handling when it doesn't.
                .entity(new LenientJsonOutputConverter<>(MigrationReport.class));
    }
}
