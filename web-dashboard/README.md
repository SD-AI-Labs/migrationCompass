# Legacy API Migration Advisor — Web Dashboard

A lightweight React (Vite) dashboard for the Legacy API Migration Advisor
backend. No heavy framework, no Tailwind build step, no state management
library — plain React state, plain CSS, and `fetch` calls straight to
each of the 5 Spring Boot modules' REST APIs. Markdown rendering uses
`marked.js` loaded from a CDN (see `index.html`) rather than an npm
dependency, keeping `package.json` minimal.

## Prerequisites

- Node.js 18+ and npm
- All 5 backend modules running (see the project root README) — this
  dashboard is a pure frontend, it has no backend of its own

## Running it

```bash
npm install
npm run dev
```

Opens on `http://localhost:5173`. **CORS is already configured** on each
backend module (`CorsConfig.java`) to allow requests from this exact
origin — if you change the dev server port, update those configs too, or
requests will fail silently with a CORS error in the browser console.

## Pages

- **Dashboard** — live health status for all 5 modules, current project summary
- **Upload** — load the bundled OrderVault example, or upload your own codebase
  (+ optional grounding docs, + optional operational data)
- **Chat** — chat-module, with streaming toggle
- **Tools Chat** — tools-module, demonstrates AI function/tool calling
- **RAG Q&A** — ask questions about the loaded codebase; view ingested
  sources and project history
- **Agent Pipeline** — run the full multi-agent analysis with live
  progress (current step, elapsed time, estimated remaining — computed
  from your own past runs' actual durations)
- **Reports** — historical run list, full detail view (including the
  structured JSON report if one was generated for that run)

## Build for production

```bash
npm run build
```

Outputs static files to `dist/` — could be served by any static file
host, though for local portfolio/demo use `npm run dev` is simplest.
