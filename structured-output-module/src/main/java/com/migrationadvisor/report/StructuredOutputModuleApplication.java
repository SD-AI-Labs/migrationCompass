package com.migrationadvisor.report;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.persistence.autoconfigure.EntityScan;

import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

/**
 * See rag-module's RagModuleApplication for why @EntityScan and
 * @EnableJpaRepositories are required here — same reasoning.
 */
@SpringBootApplication
@EntityScan("com.migrationadvisor.persistence.entity")
@EnableJpaRepositories("com.migrationadvisor.persistence.repository")
public class StructuredOutputModuleApplication {

    public static void main(String[] args) {
        SpringApplication.run(StructuredOutputModuleApplication.class, args);
    }
}
