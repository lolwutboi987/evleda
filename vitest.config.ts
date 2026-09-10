import { defineConfig } from "vitest/config";

// The transfer omitted the root test configuration. Keep Playwright browser
// specs in their own runner, and exercise the retained source and UI unit tests.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "ui/src/**/*.test.tsx"],
    passWithNoTests: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/main.ts"],
    },
  },
});
