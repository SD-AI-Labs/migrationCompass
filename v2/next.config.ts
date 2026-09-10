import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The observability + agent layers are Node-only (postgres.js, OTel SDK),
  // so nothing here is edge-runtime safe yet. Stated explicitly rather than
  // left to default, because a route silently moved to the edge runtime
  // would fail at runtime instead of at build time.
  typedRoutes: true,
};

export default nextConfig;
