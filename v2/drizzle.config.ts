import "dotenv/config";

import { defineConfig } from "drizzle-kit";

const DEFAULT_LOCAL_URL = "postgres://compass:compass@localhost:5432/compass";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL,
  },
  // The pgvector extension is created by the first migration (see
  // src/db/migrations) rather than being assumed present, so a fresh database
  // only needs `db:migrate` to be usable.
  extensionsFilters: ["postgis"],
});
