package com.migrationadvisor.tools.config;

import com.migrationadvisor.common.logging.TokenUsageLoggingAdvisor;
import com.migrationadvisor.tools.tool.LegacySystemTools;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.SimpleLoggerAdvisor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ToolsChatConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder, LegacySystemTools legacySystemTools) {
        return builder
                .defaultSystem("""
                        You are a technical assistant helping analyze a legacy or existing
                        system ahead of a migration/modernization effort.

                        You have tools available to check the LIVE operational health and
                        traffic statistics of the system's services/components. Use them
                        whenever a question depends on current operational data rather than
                        general reasoning — for example questions about uptime, incidents,
                        response times, or traffic load. Don't guess at numbers you could
                        look up with a tool. If a service name doesn't return data, check
                        the tool's response for what service names ARE available rather
                        than assuming the data doesn't exist.
                        """)
                .defaultTools(legacySystemTools)
                .defaultAdvisors(new SimpleLoggerAdvisor(), new TokenUsageLoggingAdvisor())
                .build();
    }
}
