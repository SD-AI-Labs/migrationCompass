package com.migrationadvisor.chat.controller;

import com.migrationadvisor.chat.service.ChatService;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final ChatService chatService;

    public ChatController(ChatService chatService) {
        this.chatService = chatService;
    }

    /**
     * Simple request/response chat — good for quick testing via curl/Postman.
     * Example:
     *   curl -X POST localhost:8080/api/chat \
     *     -H "Content-Type: application/json" \
     *     -d '{"conversationId":"demo-1","message":"What risks come with migrating a SOAP API to REST?"}'
     */
    @PostMapping
    public ChatResponse chat(@Valid @RequestBody ChatRequest request) {
        String reply = chatService.chat(request.conversationId(), request.message());
        return new ChatResponse(reply);
    }

    /**
     * Streaming chat via Server-Sent Events — the response body emits tokens
     * incrementally as the model generates them.
     * Example:
     *   curl -N -X POST localhost:8080/api/chat/stream \
     *     -H "Content-Type: application/json" \
     *     -d '{"conversationId":"demo-1","message":"Now summarize that in one sentence."}'
     */
    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<String> chatStream(@Valid @RequestBody ChatRequest request) {
        return chatService.chatStream(request.conversationId(), request.message());
    }
}
