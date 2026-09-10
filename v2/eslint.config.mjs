import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * Flat config. `next lint` was removed in Next 16, so ESLint is invoked directly
 * (`pnpm lint`) and only has to answer one question here: did anything get
 * introduced that typecheck and the test suite would not catch.
 */
const config = [
  {
    ignores: [".next/**", "node_modules/**", "src/db/migrations/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // Unused arguments prefixed with _ are an intentional "I know this is
      // unused" marker in the injected-dependency signatures this codebase uses.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
