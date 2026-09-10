package com.migrationadvisor.tools.config;

import com.migrationadvisor.common.logging.CorrelationIdPropagatingInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
public class RestClientConfig {

    /**
     * Points at this same app's own mock monitoring endpoints
     * (MockLegacyMonitoringController). In a real integration this base
     * URL would instead point at OrderVault's actual APM/monitoring
     * service — everything downstream (LegacySystemTools) stays the same.
     */
    @Bean
    public RestClient legacyMonitoringRestClient(@Value("${server.port:8081}") String serverPort) {
        return RestClient.builder()
                .baseUrl("http://localhost:" + serverPort)
                .requestInterceptor(new CorrelationIdPropagatingInterceptor())
                .build();
    }
}

