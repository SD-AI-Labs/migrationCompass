package com.migrationadvisor.report.config;

import com.migrationadvisor.common.logging.TokenUsageLoggingAdvisor;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.SimpleLoggerAdvisor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ReportChatConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder) {
        return builder
                .defaultSystem("""
                        You extract a structured migration report from free-text analysis
                        produced by an AI migration-planning pipeline (Discovery,
                        Architecture, and Risk agent reports). Synthesize across all three
                        inputs faithfully — do not invent details not present in them. Where
                        the inputs are ambiguous or incomplete for a required field, make
                        the most reasonable inference and keep it concise rather than
                        omitting the field.
                        """)
                .defaultAdvisors(new SimpleLoggerAdvisor(), new TokenUsageLoggingAdvisor())
                .build();
    }
}
