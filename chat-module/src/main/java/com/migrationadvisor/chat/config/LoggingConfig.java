package com.migrationadvisor.chat.config;

import com.migrationadvisor.common.logging.CorrelationIdFilter;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;

/**
 * Registers CorrelationIdFilter explicitly rather than relying on
 * component scanning — that filter lives in a different top-level package
 * (com.migrationadvisor.common) than this module's @SpringBootApplication
 * class, outside its default scan scope (same lesson as persistence-module's
 * @EntityScan/@EnableJpaRepositories elsewhere in this project).
 *
 * HIGHEST_PRECEDENCE ensures the correlation ID is established before any
 * other filter (including CORS) runs, so it's available for their logging too.
 */
@Configuration
public class LoggingConfig {

    @Bean
    public FilterRegistrationBean<CorrelationIdFilter> correlationIdFilter() {
        FilterRegistrationBean<CorrelationIdFilter> registration = new FilterRegistrationBean<>(new CorrelationIdFilter());
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return registration;
    }
}
