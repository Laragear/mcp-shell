import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporter: "json",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // main.ts executes the CLI on import (covered by the spawned e2e tests
      // instead) and stdio.ts wraps process-level teardown; tools/types.ts is
      // type-only with no runtime code; the domain index.ts files are pure
      // re-exports with no logic of their own.
      exclude: [
        "src/main.ts",
        "src/stdio.ts",
        "src/tools/types.ts",
        "src/config/index.ts",
        "src/report/index.ts",
        "src/runner/index.ts",
        "src/tools/index.ts",
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
