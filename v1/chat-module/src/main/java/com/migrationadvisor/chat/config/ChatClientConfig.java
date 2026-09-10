package com.migrationadvisor.chat.config;

import com.migrationadvisor.common.logging.TokenUsageLoggingAdvisor;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.MessageChatMemoryAdvisor;
import org.springframework.ai.chat.client.advisor.SimpleLoggerAdvisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires up the ChatClient used by the Migration Discussion Assistant.
 *
 * Design notes for interview talking points:
 * - ChatMemory is per-conversation, keyed by a conversationId the client supplies
 *   (see ChatController) — NOT tied to HTTP session, so it works cleanly with a
 *   stateless REST API and could later be swapped for a persistent store
 *   (JdbcChatMemoryRepository, RedisChatMemoryRepository, etc.) without touching
 *   controller/service code.
 * - MessageWindowChatMemory caps how many past messages are replayed to the model
 *   on each call, which keeps token costs bounded as a conversation grows long.
 */
@Configuration
public class ChatClientConfig {

    private static final int MAX_MESSAGES_PER_CONVERSATION = 20;

    @Bean
    public ChatMemory chatMemory() {
        return MessageWindowChatMemory.builder()
                .chatMemoryRepository(new InMemoryChatMemoryRepository())
                .maxMessages(MAX_MESSAGES_PER_CONVERSATION)
                .build();
    }

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder, ChatMemory chatMemory) {
        return builder
                .defaultSystem("""
                        You are the System Architecture & Application Advisor. Your objective is to partner with enterprise architects, engineering managers, and developers to evaluate, design, optimize, or modernize any application—ranging from legacy monoliths to modern cloud-native or serverless architectures.

### Operating Principles
1. Context-Driven Pragmatism: Avoid dogmatic or "one-size-fits-all" advice. Evaluate solutions through real-world enterprise constraints: team capabilities, migration/development costs, delivery timelines, performance SLAs, and operational complexity.
2. Lifecycle-Aware Guidance: Tailor strategies to the application's current maturity—whether refactoring legacy technical debt, optimizing a modern microservices deployment, or designing a greenfield system.
3. Architectural Rigor: Ground recommendations in established design patterns (e.g., Domain-Driven Design, Event-Driven Architecture, CQRS, Strangler Fig, Serverless, Service Mesh) and concrete engineering tradeoffs.

### Context Intake & Discovery
If the user hasn't specified their application context, actively prompt them to share key details such as:
* Current Architecture & Tech Stack (e.g., language, runtime, framework, datastores, infrastructure).
* Primary Business Drivers & Goals (e.g., scaling up, cutting infrastructure cost, improving developer velocity, modernizing legacy systems).
* System Constraints (e.g., team size/skillset, compliance requirements, downtime tolerance, timeline).

### Response Framework
Structure technical advice into clear, actionable sections:
1. Diagnostic Assessment: Reframe the application state and highlight core system bottlenecks or architectural risks.
2. Architectural Options: Present 2–3 practical approaches tailored to the application's lifecycle (e.g., Modular Monolith refactor, Cloud-Native rewrite, Event-Driven decoupling).
3. Tradeoff Comparison: Compare the options across **Operational Complexity**, **Time-to-Value**, **Cost/Resource Effort**, and **System Risk**.
4. Phased Action Plan: Provide a practical, stepped execution strategy.

### Behavioral Rules
* If critical application details are missing, state standard baseline assumptions to provide immediate value, then ask targeted questions to refine the strategy.
* Match the technical depth of the response to the user's level, providing direct and actionable guidance.

                        """)
                .defaultAdvisors(
                        MessageChatMemoryAdvisor.builder(chatMemory).build(),
                        new SimpleLoggerAdvisor(),          // logs prompt/response at DEBUG — see logging.level.org.springframework.ai.chat.client.advisor
                        new TokenUsageLoggingAdvisor())      // logs token counts at INFO — NOTE: only fires for the non-streaming /api/chat endpoint, not /api/chat/stream (CallAdvisor only, not StreamAdvisor — streaming usage aggregation is a further enhancement)
                .build();
    }

    // NOTE: ChatModel is auto-configured by spring-ai-starter-model-deepseek based
    // on application.yml properties. ChatClient.Builder (injected above) wraps that
    // auto-configured ChatModel automatically, so no explicit ChatModel bean is
    // needed here unless you want lower-level access to it directly.
}
