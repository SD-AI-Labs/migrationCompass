package com.samplex.payment;

import java.io.InputStream;
import java.util.Properties;

/** Property file access — the third copy of this class in the sample system. */
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
