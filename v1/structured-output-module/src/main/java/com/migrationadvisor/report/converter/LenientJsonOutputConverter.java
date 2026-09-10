package com.migrationadvisor.report.converter;

import org.springframework.ai.converter.BeanOutputConverter;
import org.springframework.ai.converter.StructuredOutputConverter;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Wraps Spring AI's BeanOutputConverter to tolerate a common model quirk:
 * wrapping the requested JSON in a markdown code fence (```json ... ```)
 * despite being asked for raw JSON. Some models do this more often than
 * others, and it otherwise causes a hard parse failure.
 *
 * Based on the pattern described in Spring's own June 2026 blog post,
 * "Self-Correcting Structured Output in Spring AI 2.0" — this is a known,
 * anticipated failure mode, not a novel workaround.
 */
public class LenientJsonOutputConverter<T> implements StructuredOutputConverter<T> {

    private static final Pattern FENCE = Pattern.compile("```(?:json)?\\s*([\\s\\S]*?)```");

    private final BeanOutputConverter<T> delegate;

    public LenientJsonOutputConverter(Class<T> targetType) {
        this.delegate = new BeanOutputConverter<>(targetType);
    }

    @Override
    public String getFormat() {
        return delegate.getFormat();
    }

    @Override
    public T convert(String source) {
        Matcher matcher = FENCE.matcher(source);
        String json = matcher.find() ? matcher.group(1).trim() : source.trim();
        return delegate.convert(json);
    }
}
