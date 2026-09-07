package com.migrationadvisor.agent.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

/**
 * Runs Discovery with a bounded self-critique/refinement loop, instead of
 * accepting the first draft as final no matter how thin it is:
 *
 * 1. Initial pass — same tool-calling investigation as before.
 * 2. Self-critique — the SAME agent reviews its own report against a
 *    completeness checklist and either says COMPLETE or lists specific
 *    gaps. This is a genuinely separate reasoning pass over the report as
 *    an artifact, not a continuation of the same train of thought — it
 *    catches cases where the investigation itself was thorough but the
 *    write-up skipped something.
 * 3. Refinement (ONLY if the critique found real gaps) — one more
 *    tool-calling pass, explicitly told what's missing, producing a
 *    revised final report.
 *
 * Bounded to exactly ONE refinement round, not an open-ended loop — this
 * is a deliberate cost/quality tradeoff: unbounded self-critique loops can
 * spiral (a model finding new nitpicks each pass) without materially
 * improving output past the first correction, and each round is a full
 * tool-calling LLM conversation, not a cheap check.
 */
@Service
public class DiscoveryAgentService {

    private static final Logger log = LoggerFactory.getLogger(DiscoveryAgentService.class);

    private static final String COMPLETENESS_CHECKLIST = """
            tech stack; service/component inventory (using actual discovered names,
            not generic placeholders); database overview (if a database exists);
            messaging/eventing overview (if one exists); external integrations
            (if any exist); observed runtime issues from logs (if logs were
            available — specific errors/exceptions cited, not just "logs exist");
            known code-level issues/risks found via the tool (not speculation)
            """;

    private final ChatClient discoveryChatClient;

    public DiscoveryAgentService(@Qualifier("discoveryChatClient") ChatClient discoveryChatClient) {
        this.discoveryChatClient = discoveryChatClient;
    }

    public String analyze() {
        String initialReport = runInitialDiscovery();

        String critique = critique(initialReport);
        if (isComplete(critique)) {
            log.info("Discovery self-critique: report judged complete, no refinement needed.");
            return initialReport;
        }

        log.info("Discovery self-critique found gaps, running one refinement pass: {}", critique);
        return refine(initialReport, critique);
    }

    private String runInitialDiscovery() {
        return discoveryChatClient.prompt()
                .user("""
                        Investigate the uploaded codebase thoroughly using your knowledge-base
                        tool. Start by discovering what services/components/modules exist and
                        what the overall architecture looks like — do not assume anything
                        about the system ahead of time. Then go deep on each thing you find:
                        each service/component individually, the database schema if one
                        exists, any messaging/eventing layer if one exists, and any external
                        integrations if any exist. Also explicitly ask whether application
                        logs are available and, if so, what errors/exceptions/warnings they
                        contain — cite specifics if you find them. Produce your structured
                        summary as described in your instructions, using the actual names you
                        discovered.
                        """)
                .call()
                .content();
    }

    /**
     * Stateless call — this Discovery report text is passed in explicitly
     * (no shared conversation memory between calls on this ChatClient),
     * same pattern used to hand Discovery's output to Architecture/Risk.
     * Deliberately has tool access available here too (same discoveryChatClient
     * bean) — the model MAY re-check something specific while critiquing
     * its own report, though the prompt asks it to judge the write-up
     * first and only dig further if genuinely necessary to confirm a gap.
     */
    private String critique(String report) {
        return discoveryChatClient.prompt()
                .user("""
                        Review the following discovery report YOU JUST WROTE against this
                        completeness checklist: %s

                        ---
                        %s
                        ---

                        If the report genuinely covers every applicable item on the checklist
                        (an item doesn't apply if the system genuinely has no database, no
                        messaging, etc. — that's fine, just confirm it was actually checked
                        rather than silently omitted), respond with EXACTLY the single word:
                        COMPLETE

                        Otherwise, respond with a concise bullet list of the SPECIFIC gaps —
                        what's missing or under-investigated, not general feedback. Don't
                        rewrite the report here, just identify what's missing.
                        """.formatted(COMPLETENESS_CHECKLIST, report))
                .call()
                .content();
    }

    private String refine(String initialReport, String critique) {
        return discoveryChatClient.prompt()
                .user("""
                        Your initial discovery report is below, along with specific gaps
                        your own review identified. Use your knowledge-base tool to
                        investigate EXACTLY those gaps, then produce a REVISED, complete
                        final report that incorporates both your original findings and
                        whatever you find addressing the gaps. Don't just append notes —
                        integrate everything into one coherent final report, in the same
                        structure as before.

                        INITIAL REPORT:
                        ---
                        %s
                        ---

                        GAPS TO ADDRESS:
                        ---
                        %s
                        ---
                        """.formatted(initialReport, critique))
                .call()
                .content();
    }

    private boolean isComplete(String critique) {
        if (critique == null) return false;
        String normalized = critique.strip().toUpperCase();
        // Exact-match on "COMPLETE" plus a couple of trivially-punctuated
        // variants — an LLM asked to respond with exactly one word will
        // still occasionally add a trailing period despite instructions.
        // Deliberately NOT using a looser "startsWith" check: that would
        // risk treating a critique that happens to START with the word
        // "Complete" as a preamble (e.g. "Complete except for...") as if
        // it had no gaps at all — a false negative here is far worse than
        // an unnecessary refinement pass.
        return normalized.equals("COMPLETE") || normalized.equals("COMPLETE.");
    }
}
