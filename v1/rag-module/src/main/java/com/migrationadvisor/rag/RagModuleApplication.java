package com.migrationadvisor.rag;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;

/**
 * NOTE: @EntityScan and @EnableJpaRepositories are REQUIRED here, not
 * optional. Spring Boot's component scanning only covers this class's own
 * package (com.migrationadvisor.rag) and sub-packages by default. Since
 * the JPA entities and repositories actually live in persistence-module
 * under com.migrationadvisor.persistence — a sibling package, not a
 * sub-package — Spring won't find them without these explicit pointers,
 * and you'd get a confusing "no bean of type ProjectRepository found"
 * error at startup instead.
 */
@SpringBootApplication
@EntityScan("com.migrationadvisor.persistence.entity")
@EnableJpaRepositories("com.migrationadvisor.persistence.repository")
public class RagModuleApplication {

    public static void main(String[] args) {
        SpringApplication.run(RagModuleApplication.class, args);
    }
}
