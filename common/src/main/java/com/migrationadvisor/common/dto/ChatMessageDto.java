package com.migrationadvisor.common.dto;

import java.time.Instant;

/**
 * Simple DTO representing a single chat turn, used by the chat-module's
 * REST layer. Kept in 'common' so later modules (e.g. agent-module) can
 * reuse the same shape when logging or replaying conversation history.
 */
public record ChatMessageDto(
        String role,        // "user" or "assistant"
        String content,
        Instant timestamp
) {
    public static ChatMessageDto userMessage(String content) {
        return new ChatMessageDto("user", content, Instant.now());
    }

    public static ChatMessageDto assistantMessage(String content) {
        return new ChatMessageDto("assistant", content, Instant.now());
    }
}
