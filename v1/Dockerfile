# Generic multi-stage Dockerfile for any of this project's 5 runnable
# Spring Boot modules. Parameterized by MODULE build-arg rather than
# duplicated 5 times — see docker-compose.yml for how each service passes
# its own module name.
#
# Build context must be the PROJECT ROOT (not an individual module folder)
# since this is a Gradle multi-project build — the whole tree is needed to
# resolve inter-module dependencies (common, persistence-module, etc.).

FROM gradle:jdk21 AS build
ARG MODULE
WORKDIR /workspace
COPY . .
RUN gradle :${MODULE}:bootJar --no-daemon

FROM eclipse-temurin:21-jre
ARG MODULE
# curl is needed for Docker Compose healthchecks against each module's
# /api/health endpoint — not present by default in the slim JRE base image.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /workspace/${MODULE}/build/libs/*.jar app.jar
# Only rag-module actually reads this at runtime (the "load example"
# convenience endpoint, and its ground-truth exclusion check), but it's
# small and copying it unconditionally for every module keeps this
# Dockerfile simple (no per-module branching) — negligible image size cost.
COPY --from=build /workspace/test-data /app/test-data
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
