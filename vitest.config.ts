import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "server.test.ts"],
    coverage: {
      include: ["server.ts", "server/**/*.ts"],
      exclude: ["**/*.test.ts"],
    },
  },
});
