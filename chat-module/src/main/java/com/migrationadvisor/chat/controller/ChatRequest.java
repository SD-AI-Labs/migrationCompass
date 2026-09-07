package com.migrationadvisor.chat.controller;

import jakarta.validation.constraints.NotBlank;

public record ChatRequest(
        @NotBlank String conversationId,
        @NotBlank String message
) {
}
