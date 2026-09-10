package com.migrationadvisor.rag.config;

import com.migrationadvisor.common.logging.TokenUsageLoggingAdvisor;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.SimpleLoggerAdvisor;
import org.springframework.ai.chat.client.advisor.api.Advisor;
import org.springframework.ai.rag.advisor.RetrievalAugmentationAdvisor;
import org.springframework.ai.rag.generation.augmentation.ContextualQueryAugmenter;
import org.springframework.ai.rag.preretrieval.query.expansion.MultiQueryExpander;
import org.springframework.ai.rag.retrieval.join.ConcatenationDocumentJoiner;
import org.springframework.ai.rag.retrieval.search.DocumentRetriever;
import org.springframework.ai.rag.retrieval.search.VectorStoreDocumentRetriever;
import org.springframework.ai.vectorstore.VectorStore;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RagChatConfig {

    @Bean
    public ChatClient chatClient(ChatClient.Builder builder, VectorStore vectorStore) {
        // Advanced modular RAG pipeline (org.springframework.ai.rag,
        // "spring-ai-rag" artifact) — replaces the earlier plain
        // QuestionAnswerAdvisor entirely. Full flow per question:
        //
        // 1. MultiQueryExpander — ONE LLM call rewrites the question into
        //    3 semantically diverse variants (not just a single rewrite —
        //    genuinely different phrasings/angles on the same question).
        //    A person's natural phrasing ("why does the loyalty stuff
        //    break so often?") often shares little vocabulary with the
        //    source code it should retrieve ("recalculateLoyaltyPoints",
        //    "CustomerAccountSessionBean") — casting 3 varied nets
        //    catches relevant chunks a single query would miss.
        // 2. VectorStoreDocumentRetriever — runs independently for EACH
        //    of the 3 expanded queries (topK=6 per query — lower than a
        //    single-query setup would use, since 3 queries' worth of
        //    results get merged next).
        // 3. ConcatenationDocumentJoiner — merges the (up to) 18 results
        //    from all 3 queries into one candidate set, de-duplicating.
        // 4. LlmRerankingPostProcessor (custom, see that class) — ONE
        //    more LLM call narrows the merged candidates down to the 8
        //    genuinely most relevant, ordered by relevance. This is the
        //    step that makes multi-query expansion actually pay off —
        //    without it, the model would just receive a noisier, more
        //    redundant context window rather than a better one.
        // 5. ContextualQueryAugmenter(allowEmptyContext=true) — builds
        //    the final augmented prompt; still lets the model answer
        //    (falling back to "not enough context," per the system
        //    prompt) rather than refusing outright if nothing clears the
        //    retriever's similarity threshold.
        //
        // Cost/latency tradeoff, stated plainly: this is 2 extra LLM
        // calls per question (expansion + reranking) beyond the final
        // answer generation, plus 3x the vector search calls (cheap,
        // no LLM). Worth it for a portfolio project demonstrating the
        // technique; for a latency-sensitive production path you'd want
        // this configurable/toggleable rather than always-on.
        //
        // project_id scoping is UNCHANGED — still applied per-request via
        // VectorStoreDocumentRetriever.FILTER_EXPRESSION (see RagController),
        // and applies identically across all 3 expanded queries' retrieval.
        DocumentRetriever documentRetriever = VectorStoreDocumentRetriever.builder()
                .vectorStore(vectorStore)
                .topK(6)
                .similarityThreshold(0.5)
                .build();

        Advisor retrievalAugmentationAdvisor = RetrievalAugmentationAdvisor.builder()
                .queryExpander(MultiQueryExpander.builder()
                        .chatClientBuilder(builder.build().mutate())
                        .numberOfQueries(3)
                        .build())
                .documentRetriever(documentRetriever)
                .documentJoiner(new ConcatenationDocumentJoiner())
                .documentPostProcessors(new LlmRerankingPostProcessor(builder.build().mutate(), 8))
                .queryAugmenter(ContextualQueryAugmenter.builder().allowEmptyContext(true).build())
                .build();

        return builder
                .defaultSystem("""
                        You are a technical assistant helping analyze a codebase that has
                        been uploaded for a modernization/migration assessment.

                        You have access to the uploaded source code, API specs, database
                        schema, and operational data (if provided) via retrieval. Ground
                        every answer in the retrieved context — cite specific file names or
                        class names where relevant, rather than speaking generally. If the
                        retrieved context doesn't contain enough information to answer
                        confidently, say so explicitly rather than guessing or inventing
                        details.
                        """)
                .defaultAdvisors(
                        retrievalAugmentationAdvisor,
                        new SimpleLoggerAdvisor(),
                        new TokenUsageLoggingAdvisor())
                .build();
    }
}
