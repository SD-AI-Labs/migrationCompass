package com.migrationadvisor.common.logging;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * Establishes a correlation ID for every incoming request, so every log
 * line across this call — and every downstream service it triggers — can
 * be tied together. Without this, tracing a single user action through
 * chat-module -> tools-module -> rag-module -> agent-module's separate
 * log streams is guesswork.
 *
 * - If the incoming request already has an X-Correlation-Id header
 *   (propagated from an upstream caller — see CorrelationIdPropagatingInterceptor,
 *   which adds this header to every outbound RestClient call this project
 *   makes between its own modules), that ID is reused.
 * - Otherwise a new one is generated — this request is the origin.
 * - The ID is put into SLF4J's MDC (Mapped Diagnostic Context) under key
 *   "correlationId", which each module's logging.pattern.console (see
 *   application.yml) includes automatically via %X{correlationId}.
 * - The ID is also echoed back as a response header, so a browser-based
 *   caller (the web-dashboard) can see/log it too if useful.
 *
 * Registered as a bean (via FilterRegistrationBean, with HIGHEST_PRECEDENCE
 * ordering) in each module's own config — NOT auto-discovered via
 * component scanning, since this class lives in a different top-level
 * package (com.migrationadvisor.common vs. e.g. com.migrationadvisor.chat)
 * than each module's @SpringBootApplication class. See each module's
 * LoggingConfig.java for the explicit registration.
 */
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER_NAME = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String correlationId = request.getHeader(HEADER_NAME);
        if (correlationId == null || correlationId.isBlank()) {
            correlationId = UUID.randomUUID().toString();
        }

        MDC.put(MDC_KEY, correlationId);
        response.setHeader(HEADER_NAME, correlationId);
        try {
            filterChain.doFilter(request, response);
        } finally {
            // Always clear — MDC is thread-local, and app servers reuse
            // threads across requests, so a stale value here would leak
            // into an unrelated later request's logs.
            MDC.remove(MDC_KEY);
        }
    }
}
