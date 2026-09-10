package com.migrationadvisor.agent.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

/**
 * Runs Architecture with the same bounded self-critique/refinement loop
 * as DiscoveryAgentService (see that class's javadoc for the full
 * rationale) — a first proposal is reviewed against a completeness
 * checklist, and refined ONCE more only if the review finds real gaps.
 */
@Service
public class ArchitectureAgentService {

    private static final Logger log = LoggerFactory.getLogger(ArchitectureAgentService.class);

    private static final String COMPLETENESS_CHECKLIST = """
            target service/component boundaries explicitly addressed (matching
            existing boundaries 1:1, redrawn, or staying as-is — a decision, not
            silence); key technology choices grounded in the ACTUAL discovered
            stack and domain, not a generic/default stack; a phased plan IF
            restructuring is warranted, OR an explicit statement that the current
            architecture doesn't need major changes if that's what the evidence
            shows; every recommendation traceable to something the Discovery
            findings actually reported, not generic advice
            """;

    private final ChatClient architectureChatClient;

    public ArchitectureAgentService(@Qualifier("architectureChatClient") ChatClient architectureChatClient) {
        this.architectureChatClient = architectureChatClient;
    }

    public String proposeArchitecture(String discoveryReport) {
        String initialProposal = runInitialProposal(discoveryReport);

        String critique = critique(discoveryReport, initialProposal);
        if (isComplete(critique)) {
            log.info("Architecture self-critique: proposal judged complete, no refinement needed.");
            return initialProposal;
        }

        log.info("Architecture self-critique found gaps, running one refinement pass: {}", critique);
        return refine(discoveryReport, initialProposal, critique);
    }

    private String runInitialProposal(String discoveryReport) {
        return architectureChatClient.prompt()
                .user("""
                        Here is the Discovery Agent's report on the system being analyzed:

                        ---
                        %s
                        ---

                        Propose the target architecture and phased modernization plan for
                        THIS specific system, as described in your instructions — grounded
                        in the actual stack, domain, and issues the Discovery report
                        describes, not a generic template applied regardless of what was
                        found. Use your knowledge-base tool if you need to verify or dig
                        into a specific detail the Discovery report doesn't fully cover.
                        """.formatted(discoveryReport))
                .call()
                .content();
    }

    /** Stateless call — same pattern as DiscoveryAgentService's critique(). */
    private String critique(String discoveryReport, String proposal) {
        return architectureChatClient.prompt()
                .user("""
                        Review the following architecture proposal YOU JUST WROTE against
                        this completeness checklist: %s

                        DISCOVERY REPORT IT WAS BASED ON:
                        ---
                        %s
                        ---

                        YOUR PROPOSAL:
                        ---
                        %s
                        ---

                        If the proposal genuinely covers every item on the checklist,
                        respond with EXACTLY the single word:
                        COMPLETE

                        Otherwise, respond with a concise bullet list of the SPECIFIC
                        gaps — what's missing, ungrounded in the actual findings, or
                        defaulted to a generic template. Don't rewrite the proposal here,
                        just identify what's missing.
                        """.formatted(COMPLETENESS_CHECKLIST, discoveryReport, proposal))
                .call()
                .content();
    }

    private String refine(String discoveryReport, String initialProposal, String critique) {
        return architectureChatClient.prompt()
                .user("""
                        Your initial architecture proposal is below, along with specific
                        gaps your own review identified. Use your knowledge-base tool if
                        needed to investigate exactly those gaps, then produce a REVISED,
                        complete final proposal. Don't just append notes — integrate
                        everything into one coherent final proposal, in the same structure
                        as before.

                        DISCOVERY REPORT:
                        ---
                        %s
                        ---

                        INITIAL PROPOSAL:
                        ---
                        %s
                        ---

                        GAPS TO ADDRESS:
                        ---
                        %s
                        ---
                        """.formatted(discoveryReport, initialProposal, critique))
                .call()
                .content();
    }

    private boolean isComplete(String critique) {
        if (critique == null) return false;
        String normalized = critique.strip().toUpperCase();
        return normalized.equals("COMPLETE") || normalized.equals("COMPLETE.");
    }
}
