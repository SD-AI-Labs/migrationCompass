package com.migrationadvisor.persistence.repository;

import com.migrationadvisor.persistence.entity.Project;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ProjectRepository extends JpaRepository<Project, UUID> {

    List<Project> findAllByOrderByCreatedAtDesc();

    /** Duplicate-upload detection — see Project.sourceHash's javadoc. */
    Optional<Project> findFirstBySourceHashAndSourceTypeOrderByCreatedAtDesc(String sourceHash, Project.SourceType sourceType);
}
