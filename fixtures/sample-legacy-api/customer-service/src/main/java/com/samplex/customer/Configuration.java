package com.samplex.customer;

import java.io.InputStream;
import java.util.Properties;

/**
 * Property file access.
 *
 * Loads once from the classpath at first use. Every service in this system reads
 * its configuration from a local `.properties` file rather than from the
 * container, so the deployment scripts rewrite the file per environment.
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
