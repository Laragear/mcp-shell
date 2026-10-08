import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporter: "json",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts executes the CLI on import (covered by the spawned e2e tests
      // instead) and stdio.ts wraps process-level teardown; tools/types.ts is
      // type-only with no runtime code.
      exclude: ["src/main.ts", "src/stdio.ts", "src/tools/types.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
