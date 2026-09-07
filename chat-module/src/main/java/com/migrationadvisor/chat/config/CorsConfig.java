package com.migrationadvisor.chat.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Allows the web-dashboard frontend (running on Vite's dev server, a
 * different origin/port than this module) to call this module's REST
 * endpoints. Without this, every dashboard API call fails silently with a
 * CORS error in the browser console — easy to miss if you're only testing
 * via curl, which isn't subject to CORS at all.
 */
@Configuration
public class CorsConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOrigins("http://localhost:5173", "http://localhost:4173") // Vite dev server + preview server
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*");
    }
}
