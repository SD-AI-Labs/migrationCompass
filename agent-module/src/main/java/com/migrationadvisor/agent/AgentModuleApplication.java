package com.migrationadvisor.agent;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.persistence.autoconfigure.EntityScan;
import org.springframework.data.jpa.repository.config.EnableJpaRepositories;
import org.springframework.scheduling.annotation.EnableAsync;

/**
 * See rag-module's RagModuleApplication for why @EntityScan and
 * @EnableJpaRepositories are required (not optional) here — same reason:
 * persistence-module's JPA classes live in a sibling package, outside
 * this class's default component-scan scope.
 *
 * @EnableAsync activates Spring's @Async support, used by
 * MigrationPlanningOrchestrator.executeRunAsync() to run pipeline
 * executions on a background thread — see application.yml for the virtual
 * thread executor config that backs it.
 */
@SpringBootApplication
@EntityScan("com.migrationadvisor.persistence.entity")
@EnableJpaRepositories("com.migrationadvisor.persistence.repository")
@EnableAsync
public class AgentModuleApplication {

    public static void main(String[] args) {
        SpringApplication.run(AgentModuleApplication.class, args);
    }
}
