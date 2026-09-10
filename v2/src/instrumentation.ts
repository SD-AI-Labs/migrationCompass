/**
 * Next.js calls this once per server process, before any route handles a
 * request. Kept to dynamic imports so the edge runtime never pulls in Node-only
 * modules (postgres.js, the OTel Node SDK).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerTracing } = await import("@/lib/observability/tracing");
  registerTracing();
}
