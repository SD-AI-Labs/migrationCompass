package com.migrationadvisor.report.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Explicit Jackson configuration to provide ObjectMapper bean.
 * Spring Boot 4.1.0 should auto-create this via spring-boot-starter-web,
 * but when using library modules (persistence-module) without Spring Boot plugin,
 * the auto-configuration may not trigger. This ensures ObjectMapper is always available.
 */
@Configuration
public class JacksonConfig {

    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper();
    }
}
