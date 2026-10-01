import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "upstream/**",
      "codex-prod/**",
      "codex-prod-extracted/**",
    ],
  },
});
