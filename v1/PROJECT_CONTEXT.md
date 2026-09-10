# Project Context — Legacy API Migration Advisor

_Last updated: 2026-09-02. Use this as the shared reference whenever picking this project back up — it captures the architecture, current state, and the fixes already applied, so we don't have to rediscover them each session._

## What this project is

A Spring Boot + Spring AI portfolio project demonstrating RAG, tool calling,
multi-agent orchestration, and structured output, applied to legacy system
migration analysis. Generic by design — analyzes any uploaded codebase, not
just the bundled example. A fictional legacy system, "OrderVault," ships as
a zero-setup example, but the pipeline works the same way against a real
uploaded project (the AI discovers what services/components exist rather
than being told upfront).

Built module-by-module so each AI capability can be understood and
demoed independently before being composed together.

## Architecture / modules

| Module | Port | Role |
|---|---|---|
| `common` | — | shared DTOs used across modules |
| `persistence-module` | — | shared JPA entities/repos (`Project`, `AnalysisRun`), backed by Postgres |
| `chat-module` | 8080 | conversational assistant, per-conversation memory, SSE streaming, DeepSeek |
| `tools-module` | 8081 | AI-callable functions (`checkApiHealth`, `getTrafficStats`) backed by monitoring REST endpoints |
| `rag-module` | 8082 | document Q&A over an uploaded codebase (Ollama local embeddings + Postgres/pgvector) |
| `agent-module` | 8083 | multi-agent migration planning: Discovery → Architecture → Risk → Ground-truth Comparison; sync or async (start/poll/result) |
| `structured-output-module` | 8084 | extracts structured JSON migration report from the agent pipeline's free-text output |
| `web-dashboard` | 5173 | React (Vite) GUI: upload, live agent progress, RAG Q&A, chat, report history |

`agent-module` composes `rag-module` + `tools-module` over HTTP (both must be running for the full pipeline). `structured-output-module`'s `/generate-from-pipeline` endpoint chains the entire pipeline end-to-end — the single best command for an interview demo.

## Stack

- Java 21, Spring Boot 4.1.0, Gradle (Groovy DSL)
- Spring AI 2.0.0 (built on Spring Framework 7.0, Jackson 3)
  - Chat/agents/tools: **DeepSeek** (`deepseek-chat`)
  - Embeddings: **Ollama** (`nomic-embed-text`, local)
  - Vector storage: **PostgreSQL + pgvector**
- Observability: correlation IDs across every inter-module call, `SimpleLoggerAdvisor` + custom `TokenUsageLoggingAdvisor`, Micrometer + Zipkin distributed tracing (`localhost:9411`)
- Frontend: React + Vite, no state management library, `marked.js` loaded via CDN (not npm) for markdown rendering

## Running it

Two options — don't run both at once (same host ports):

**Individual modules (dev):**
```bash
docker compose up -d postgres ollama ollama-init zipkin
./run.sh :chat-module:bootRun        # 8080
./run.sh :tools-module:bootRun       # 8081
./run.sh :rag-module:bootRun         # 8082 (needs local Ollama running + model pulled)
./run.sh :agent-module:bootRun       # 8083 (needs rag + tools up)
./run.sh :structured-output-module:bootRun  # 8084
cd web-dashboard && npm run dev      # 5173
```

**Fully containerized (clean demo):**
```bash
docker compose up -d --build
```

Use `./run.sh <gradle-task>` (not raw `gradle`/`./gradlew`) — it loads `.env` into only the single Gradle process, avoiding a persistently-exported API key in the shell.

## Current status

All 6 backend modules + web dashboard are built and were confirmed running together (all 9 containers healthy: 5 Spring modules, postgres, ollama, zipkin, ollama-init).

### Docker/build fixes already applied (getting it running locally)
1. Ollama healthcheck: `curl -f ...` → `ollama list` (curl isn't in the ollama image)
2. Removed `spring-boot-starter-data-jpa` from common `build.gradle` (was cascading DB config into stateless modules)
3. Added explicit `spring-boot-starter-data-jpa` to `rag-module` (needs pgvector)
4. Added `SPRING_AUTOCONFIGURE_EXCLUDE` env vars in `docker-compose.yml` for `chat-module`/`tools-module` to suppress `OllamaChatAutoConfiguration`, `DataSourceAutoConfiguration`, `DataSourceTransactionManagerAutoConfiguration`, `HibernateJpaAutoConfiguration`
5. Added `spring-boot-starter-json` to `structured-output-module` (Jackson auto-config for `ObjectMapper`)
6. Added an explicit `JacksonConfig` `@Bean` for `ObjectMapper` in `structured-output-module` (starter alone wasn't enough)

### Frontend UX fixes already applied (web-dashboard)
1. **Markdown not rendered** in Chat, Tools Chat, and RAG pages — only the Agent Pipeline page used `MarkdownView`. Fixed by rendering assistant/answer text through `<MarkdownView>` in `ChatPage.jsx`, `ToolsChatPage.jsx`, `RagPage.jsx` (user messages stay plain text). Also cleaned up `styles.css`: removed conflicting `white-space: pre-wrap` from `.answer-box`, added `.chat-bubble .markdown-body { white-space: normal }` so nested markdown isn't fighting the bubble's pre-wrap, and added a base `.markdown-body` rule set (paragraph/list spacing, line-height) since none existed.
2. **Agent progress disappears on tab switch** and **Reports list disappears after browsing other tabs** — same root cause: `App.jsx` conditionally rendered pages with `{tab === 'x' && <Page/>}`, which unmounts a page (destroying its state, including Agent page's polling `setInterval`) every time you switch away. Fixed by keeping every page permanently mounted and toggling visibility with inline `display: none/block` instead of removing them from the tree.
3. **Streamed chat words smashed together with no spaces** (e.g. `"Goodquestion—thisisacommon..."`) — a separate, deeper bug from #1, only affecting `ChatPage`'s streaming mode. Root cause: `chatClient.stream().content()` in `ChatService.java` emits raw token deltas that routinely start with a leading space (tokenizer convention, marks a word boundary, e.g. `" question"`). Spring WebFlux's SSE writer serializes a `Flux<String>` as `data:<content>` with **no delimiter space** after the colon (confirmed against Spring's `ServerSentEventHttpMessageWriter` — this is a known point of confusion, since a hand-rolled SSE server conventionally would add one). `client.js`'s `streamChatMessage` did `line.slice(5).trimStart()`, assuming it needed to strip a delimiter space — but since `data:` is exactly 5 chars, `slice(5)` already returns the exact token, so `.trimStart()` was stripping the token's own meaningful leading space on every chunk. Fixed by removing `.trimStart()` entirely — `line.slice(5)` alone is correct.

Delivered as a small patch zip (`legacy-api-migration-advisor-ux-fixes.zip`) containing just: `App.jsx`, `styles.css`, `client.js`, `ChatPage.jsx`, `ToolsChatPage.jsx`, `RagPage.jsx`.

**Not yet verified:** `npm run build` couldn't be run in the sandbox used to make these edits (unrelated missing native `rolldown` binding for that container's platform) — worth running `npm run build` or `npm run dev` locally to confirm after applying.

## Roadmap (not yet built)

- Endpoint to re-activate an older project as "active" without re-uploading (multi-project storage keeps every project's embeddings, but "active" = "most recently created" with no explicit switch-back)
- Smarter log-aware chunking for large uploaded log files (currently one document per log file before chunking; grouping by timestamp window or log level would retrieve more precisely)

## Design notes (interview talking points)

- **Provider abstraction**: DeepSeek for chat/agents, local Ollama for embeddings — shows picking the right model per capability via Spring AI's provider-agnostic APIs, low-risk to swap later.
- **Conversation memory is per-conversation-ID, not per-HTTP-session** — keeps the API stateless-friendly, trivial to swap the in-memory store for JDBC/Redis later.
- **Test data is entirely synthetic** — fictional "OrderVault," invented for this project, no real employer IP involved.
- **Run history is permanent** — `analysis_runs` persists regardless of whether the source project's vector embeddings still exist.
- **Correlation IDs survive the async pipeline's virtual-thread boundary** (`MigrationPlanningOrchestrator.executeRunAsync` handles the MDC-doesn't-cross-threads gotcha).

## Open questions / things to watch next session

- Confirm the frontend build/dev server actually runs clean after the UX patch (blocked on sandbox limitation above).
- No other known open bugs as of this update — next session should start with "did the patch apply cleanly?" before moving to new work.
