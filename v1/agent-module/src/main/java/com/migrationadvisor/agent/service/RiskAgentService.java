package com.migrationadvisor.agent.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

/**
 * Runs Risk assessment with the same bounded self-critique/refinement
 * loop as Discovery and Architecture (see DiscoveryAgentService's
 * javadoc for the full rationale).
 */
@Service
public class RiskAgentService {

    private static final Logger log = LoggerFactory.getLogger(RiskAgentService.class);

    private static final String COMPLETENESS_CHECKLIST = """
            every service/component named in the Discovery findings was actually
            checked with the health and traffic tools (or the tool's "no data"
            response was noted explicitly, not silently skipped); the ranking
            gives brief evidence-based reasoning per item, not just a bare list;
            log-observed runtime issues from Discovery are weighted appropriately
            (not treated the same as an untested code smell); no operational
            numbers are stated as fact without a tool call actually backing them
            """;

    private final ChatClient riskChatClient;

    public RiskAgentService(@Qualifier("riskChatClient") ChatClient riskChatClient) {
        this.riskChatClient = riskChatClient;
    }

    public String assessRisk(String discoveryReport) {
        String initialAssessment = runInitialAssessment(discoveryReport);

        String critique = critique(discoveryReport, initialAssessment);
        if (isComplete(critique)) {
            log.info("Risk self-critique: assessment judged complete, no refinement needed.");
            return initialAssessment;
        }

        log.info("Risk self-critique found gaps, running one refinement pass: {}", critique);
        return refine(discoveryReport, initialAssessment, critique);
    }

    private String runInitialAssessment(String discoveryReport) {
        return riskChatClient.prompt()
                .user("""
                        Here is the Discovery Agent's report on the system being analyzed:

                        ---
                        %s
                        ---

                        Using your health and traffic tools for each service mentioned
                        above, and your knowledge-base tool for any risk-relevant code
                        detail the discovery findings don't fully cover, produce a
                        risk-ranked migration assessment as described in your instructions.
                        """.formatted(discoveryReport))
                .call()
                .content();
    }

    /** Stateless call — same pattern as DiscoveryAgentService's critique(). */
    private String critique(String discoveryReport, String assessment) {
        return riskChatClient.prompt()
                .user("""
                        Review the following risk assessment YOU JUST WROTE against this
                        completeness checklist: %s

                        DISCOVERY REPORT IT WAS BASED ON:
                        ---
                        %s
                        ---

                        YOUR ASSESSMENT:
                        ---
                        %s
                        ---

                        If the assessment genuinely covers every item on the checklist,
                        respond with EXACTLY the single word:
                        COMPLETE

                        Otherwise, respond with a concise bullet list of the SPECIFIC
                        gaps — which services weren't checked, where reasoning is missing,
                        or where a number is stated without a tool call backing it. Don't
                        rewrite the assessment here, just identify what's missing.
                        """.formatted(COMPLETENESS_CHECKLIST, discoveryReport, assessment))
                .call()
                .content();
    }

    private String refine(String discoveryReport, String initialAssessment, String critique) {
        return riskChatClient.prompt()
                .user("""
                        Your initial risk assessment is below, along with specific gaps
                        your own review identified. Use your health/traffic tools and/or
                        knowledge-base tool as needed to fill exactly those gaps, then
                        produce a REVISED, complete final assessment. Don't just append
                        notes — integrate everything into one coherent final assessment,
                        in the same structure as before.

                        DISCOVERY REPORT:
                        ---
                        %s
                        ---

                        INITIAL ASSESSMENT:
                        ---
                        %s
                        ---

                        GAPS TO ADDRESS:
                        ---
                        %s
                        ---
                        """.formatted(discoveryReport, initialAssessment, critique))
                .call()
                .content();
    }

    private boolean isComplete(String critique) {
        if (critique == null) return false;
        String normalized = critique.strip().toUpperCase();
        return normalized.equals("COMPLETE") || normalized.equals("COMPLETE.");
    }
}
