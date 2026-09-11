package com.samplex.order;

import java.io.InputStream;
import java.util.Properties;

/**
 * Property file access — a copy of the same class in customer-service and
 * payment-service. Three copies, three slightly different error paths; a
 * duplication the migration is expected to notice.
 */
public final class Configuration {

    private static final Properties PROPERTIES = load();

    private Configuration() {
    }

    public static String get(String key, String defaultValue) {
        return PROPERTIES.getProperty(key, defaultValue);
    }

    private static Properties load() {
        Properties properties = new Properties();
        try (InputStream stream = Configuration.class.getResourceAsStream("/application.properties")) {
            if (stream != null) {
                properties.load(stream);
            }
        } catch (Exception e) {
            throw new RuntimeException("Unable to load application.properties", e);
        }
        return properties;
    }
}
