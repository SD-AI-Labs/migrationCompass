package com.migrationadvisor.agent.config;

import com.migrationadvisor.common.logging.CorrelationIdPropagatingInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestClient;

@Configuration
public class RestClientConfig {

    @Bean
    public RestClient ragServiceRestClient(@Value("${ordervault.services.rag-module-url}") String ragModuleUrl) {
        return RestClient.builder()
                .baseUrl(ragModuleUrl)
                .requestInterceptor(new CorrelationIdPropagatingInterceptor())
                .build();
    }

    @Bean
    public RestClient toolsServiceRestClient(@Value("${ordervault.services.tools-module-url}") String toolsModuleUrl) {
        return RestClient.builder()
                .baseUrl(toolsModuleUrl)
                .requestInterceptor(new CorrelationIdPropagatingInterceptor())
                .build();
    }
}

