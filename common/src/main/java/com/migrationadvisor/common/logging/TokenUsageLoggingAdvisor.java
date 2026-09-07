package com.migrationadvisor.common.logging;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClientRequest;
import org.springframework.ai.chat.client.ChatClientResponse;
import org.springframework.ai.chat.client.advisor.api.CallAdvisor;
import org.springframework.ai.chat.client.advisor.api.CallAdvisorChain;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.core.Ordered;

/**
 * Logs token usage for every LLM call this project makes — the one piece
 * of AI-specific observability that's genuinely missing by default. Spring
 * AI's ChatResponse carries real usage numbers (prompt/completion/total
 * tokens) from the provider, but calling .content() (as most of this
 * project's services do, for simplicity) silently discards that metadata.
 * This advisor captures it centrally instead, without requiring every
 * call site to switch to the more verbose .chatResponse() API.
 *
 * A pure observation concern — LOWEST_PRECEDENCE - 1000 ensures it runs
 * last in the advisor chain (after RAG retrieval, memory, etc. have all
 * already done their work), so it never interferes with anything else.
 *
 * Add to a ChatClient via .defaultAdvisors(new TokenUsageLoggingAdvisor(), ...)
 * — see each module's ChatClient config for where this is wired in.
 */
public class TokenUsageLoggingAdvisor implements CallAdvisor {

    private static final Logger log = LoggerFactory.getLogger(TokenUsageLoggingAdvisor.class);

    @Override
    public String getName() {
        return this.getClass().getSimpleName();
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE - 1000;
    }

    @Override
    public ChatClientResponse adviseCall(ChatClientRequest chatClientRequest, CallAdvisorChain callAdvisorChain) {
        ChatClientResponse response = callAdvisorChain.nextCall(chatClientRequest);

        if (response.chatResponse() != null && response.chatResponse().getMetadata() != null) {
            Usage usage = response.chatResponse().getMetadata().getUsage();
            if (usage != null) {
                log.info("LLM call token usage — prompt: {}, completion: {}, total: {}",
                        usage.getPromptTokens(), usage.getCompletionTokens(), usage.getTotalTokens());
            }
        }

        return response;
    }
}
