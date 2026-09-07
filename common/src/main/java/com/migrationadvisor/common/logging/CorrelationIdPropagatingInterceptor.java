package com.migrationadvisor.common.logging;

import org.slf4j.MDC;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

import java.io.IOException;

/**
 * Adds the current request's correlation ID (see CorrelationIdFilter) as a
 * header on every outbound RestClient call this project makes between its
 * own modules (agent-module -> rag-module, agent-module -> tools-module,
 * structured-output-module -> agent-module). This is what makes the ID
 * actually a CORRELATION id rather than just a per-service request id —
 * one user action tracing across every module it touches.
 *
 * Add via RestClient.Builder's .requestInterceptor(new
 * CorrelationIdPropagatingInterceptor()) wherever this project builds a
 * RestClient pointed at another one of its own modules — see each
 * module's RestClientConfig.
 */
public class CorrelationIdPropagatingInterceptor implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body, ClientHttpRequestExecution execution) throws IOException {
        String correlationId = MDC.get(CorrelationIdFilter.MDC_KEY);
        if (correlationId != null) {
            request.getHeaders().set(CorrelationIdFilter.HEADER_NAME, correlationId);
        }
        return execution.execute(request, body);
    }
}
