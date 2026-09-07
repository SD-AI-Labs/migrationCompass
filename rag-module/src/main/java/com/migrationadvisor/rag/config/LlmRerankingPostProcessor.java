package com.migrationadvisor.rag.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.document.Document;
import org.springframework.ai.rag.Query;
import org.springframework.ai.rag.postretrieval.document.DocumentPostProcessor;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reranks (and prunes) retrieved documents by relevance to the query,
 * using a fast, tool-less LLM call rather than a dedicated cross-encoder
 * reranker model (Spring AI doesn't bundle one out of the box — that
 * would mean standing up a separate model/API just for this). Runs AFTER
 * retrieval/joining, right before the query augmenter builds the final
 * prompt — this is exactly the "lost in the middle" / noise-reduction
 * step DocumentPostProcessor exists for.
 *
 * With MultiQueryExpander in play (see RagChatConfig), the joined
 * candidate set can have real duplication and off-target hits across
 * the expanded queries' independent retrievals — reranking is what
 * actually narrows that back down to the genuinely useful subset instead
 * of just concatenating everything into the prompt.
 *
 * Fails OPEN: if the model's response can't be parsed for any reason,
 * the original (unreranked) document list is returned unchanged rather
 * than the whole /ask call failing — reranking is a quality improvement,
 * not something that should be a single point of failure for RAG itself.
 */
public class LlmRerankingPostProcessor implements DocumentPostProcessor {

    private static final Logger log = LoggerFactory.getLogger(LlmRerankingPostProcessor.class);
    private static final Pattern NUMBER_PATTERN = Pattern.compile("\\d+");

    private final ChatClient rerankingChatClient;
    private final int keepTop;

    public LlmRerankingPostProcessor(ChatClient.Builder chatClientBuilder, int keepTop) {
        this.rerankingChatClient = chatClientBuilder.build();
        this.keepTop = keepTop;
    }

    @Override
    public List<Document> process(Query query, List<Document> documents) {
        if (documents.size() <= keepTop) {
            return documents; // nothing to prune, reranking wouldn't change the outcome
        }

        String numbered = buildNumberedList(documents);

        String response;
        try {
            response = rerankingChatClient.prompt()
                    .user("""
                            Question: %s

                            Below are %d retrieved text chunks, numbered. Identify the %d
                            chunks MOST relevant to actually answering the question, ordered
                            from most to least relevant. Respond with ONLY a comma-separated
                            list of chunk numbers (e.g. "3,1,7,2") — no other text.

                            %s
                            """.formatted(query.text(), documents.size(), keepTop, numbered))
                    .call()
                    .content();
        } catch (Exception e) {
            log.warn("Reranking call failed, falling back to unreranked retrieval order: {}", e.getMessage());
            return documents;
        }

        List<Document> reranked = parseRankedOrder(response, documents);
        return reranked != null ? reranked : documents;
    }

    private String buildNumberedList(List<Document> documents) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < documents.size(); i++) {
            String source = String.valueOf(documents.get(i).getMetadata().getOrDefault("source", "unknown"));
            String snippet = documents.get(i).getText();
            if (snippet != null && snippet.length() > 300) {
                snippet = snippet.substring(0, 300) + "...";
            }
            sb.append("[").append(i + 1).append("] (").append(source).append(") ").append(snippet).append("\n\n");
        }
        return sb.toString();
    }

    /** Null if the response couldn't be parsed into at least one valid, in-range index. */
    private List<Document> parseRankedOrder(String response, List<Document> documents) {
        if (response == null) return null;
        Matcher matcher = NUMBER_PATTERN.matcher(response);
        List<Document> ordered = new ArrayList<>();
        java.util.Set<Integer> seen = new java.util.HashSet<>();
        while (matcher.find() && ordered.size() < keepTop) {
            int oneBasedIndex = Integer.parseInt(matcher.group());
            int zeroBasedIndex = oneBasedIndex - 1;
            if (zeroBasedIndex >= 0 && zeroBasedIndex < documents.size() && seen.add(zeroBasedIndex)) {
                ordered.add(documents.get(zeroBasedIndex));
            }
        }
        return ordered.isEmpty() ? null : ordered;
    }
}
