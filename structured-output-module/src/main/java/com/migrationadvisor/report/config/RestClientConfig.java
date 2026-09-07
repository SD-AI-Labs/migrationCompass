package com.migrationadvisor.report.config;

import com.migrationadvisor.common.logging.CorrelationIdPropagatingInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.time.Duration;

@Configuration
public class RestClientConfig {

    /**
     * POST /api/agent/analyze runs the ENTIRE 4-agent pipeline
     * (Discovery -> Architecture -> Risk -> Comparison) synchronously
     * before responding — each step is its own LLM conversation, and
     * Discovery's tool-calling loop can make several rag-module round
     * trips on top of that. This routinely takes several minutes.
     *
     * None of this project's RestClient beans previously set an explicit
     * timeout, which left them at whatever implicit default the
     * classpath's HTTP client implementation happened to apply — for this
     * SPECIFIC call (the only one spanning the full pipeline rather than
     * a single step), that default was shorter than the pipeline
     * genuinely needs, causing
     * io.netty.handler.timeout.ReadTimeoutException /
     * ResourceAccessException failures on otherwise-successful runs.
     *
     * connectTimeout stays short (agent-module either accepts the TCP
     * connection quickly or it's not running) — readTimeout is set
     * generously since THIS is the call that has to outlast the whole
     * pipeline's actual duration.
     */
    @Bean
    public RestClient agentServiceRestClient(
            @Value("${ordervault.services.agent-module-url:http://localhost:8083}") String agentModuleUrl) {
        if (agentModuleUrl == null || agentModuleUrl.isBlank()) {
            throw new IllegalArgumentException("ordervault.services.agent-module-url must be configured");
        }

        JdkClientHttpRequestFactory requestFactory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(10))
                        .build());
        requestFactory.setReadTimeout(Duration.ofMinutes(15));

        return RestClient.builder()
                .baseUrl(agentModuleUrl)
                .requestFactory(requestFactory)
                .requestInterceptor(new CorrelationIdPropagatingInterceptor())
                .build();
    }
}

