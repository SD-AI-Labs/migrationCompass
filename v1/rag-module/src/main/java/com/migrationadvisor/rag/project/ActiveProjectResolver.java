package com.migrationadvisor.rag.project;

import com.migrationadvisor.persistence.entity.Project;
import com.migrationadvisor.persistence.repository.ProjectRepository;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

/**
 * Resolves "which project should this request operate on" — shared by
 * every endpoint that now accepts an OPTIONAL explicit projectId (added
 * so the dashboard can let a person pick any previously uploaded project,
 * not just whichever one happens to be most recent):
 *
 * - If a projectId was explicitly requested, validate it actually exists
 *   and use it as-is — this is what makes "pick any uploaded project"
 *   possible.
 * - If none was requested, fall back to the previous default behavior:
 *   whichever Project row is most recently created. This keeps every
 *   existing caller (curl examples in the README, older dashboard builds)
 *   working unchanged.
 */
@Component
public class ActiveProjectResolver {

    private final ProjectRepository projectRepository;

    public ActiveProjectResolver(ProjectRepository projectRepository) {
        this.projectRepository = projectRepository;
    }

    public UUID resolve(UUID requestedProjectId) {
        if (requestedProjectId != null) {
            if (!projectRepository.existsById(requestedProjectId)) {
                throw new IllegalArgumentException("No project found with id " + requestedProjectId);
            }
            return requestedProjectId;
        }
        return mostRecentProjectId();
    }

    private UUID mostRecentProjectId() {
        List<Project> projects = projectRepository.findAllByOrderByCreatedAtDesc();
        if (projects.isEmpty()) {
            throw new IllegalStateException("No project has been loaded yet — call " +
                    "POST /api/rag/upload/load-example or /api/rag/upload/source first.");
        }
        return projects.get(0).getId();
    }
}
