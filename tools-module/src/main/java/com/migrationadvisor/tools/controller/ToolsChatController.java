package com.migrationadvisor.tools.controller;

import org.springframework.ai.chat.client.ChatClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/tools-chat")
public class ToolsChatController {

    private final ChatClient chatClient;

    public ToolsChatController(ChatClient chatClient) {
        this.chatClient = chatClient;
    }

    /**
     * Example:
     *   curl -X POST localhost:8081/api/tools-chat \
     *     -H "Content-Type: application/json" \
     *     -d '{"message":"Is InventoryCheckService healthy right now, and how much does its traffic spike during sales?"}'
     *
     * The model should call both checkApiHealth and getTrafficStats to
     * answer this, since it needs live data for both parts of the question.
     */
    @PostMapping
    public ChatReplyResponse chat(@RequestBody ChatMessageRequest request) {
        String reply = chatClient.prompt()
                .user(request.message())
                .call()
                .content();
        return new ChatReplyResponse(reply);
    }

    public record ChatMessageRequest(String message) {}
    public record ChatReplyResponse(String reply) {}
}
