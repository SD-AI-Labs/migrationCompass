# Legacy API Migration Advisor

**This repo is mid-rewrite.** What's here now is V1 (Java / Spring Boot /
Spring AI) — fully working, documented, and preserved as-is. V2 (a
product rethink, new stack) is planned but not yet built.

## Where things are

- **[`v1/README.md`](./v1/README.md)** — the original, complete project:
  5 Spring Boot microservices demonstrating RAG, tool calling,
  multi-agent orchestration, and structured output, with a React
  dashboard. Fully functional — see that README for setup and usage.
- **[`PROJECT_PLAN_V2.md`](./PROJECT_PLAN_V2.md)** — the plan for V2: why
  it's a rewrite and not an iteration, the new product design (one
  continuous page, rubric-based scoring, code-only-vs-refined
  estimates), the new stack (Next.js / Vercel AI SDK / LangGraph.js), and
  the build order. Read this before touching any V2 code.

## Why V2 exists

V1's dashboard navigation mirrored its five backend services one-to-one
(Chat tab, RAG Q&A tab, Tools Chat tab, Agent Pipeline tab, Reports tab)
— which meant using the product required understanding the *backend's*
organizing principle, not just what you were trying to do. V2 is a
ground-up product rethink around actual user journeys instead, on a
stack better suited to the result. Full reasoning in
`PROJECT_PLAN_V2.md`.

V1 isn't deprecated because it was wrong — it did exactly what it was
built for (demonstrate each Spring AI capability cleanly, in isolation).
It's kept, intact and documented, both as a reference and because the
Java/Spring AI engineering it demonstrates remains a legitimate,
separate piece of work worth showing on its own terms.
