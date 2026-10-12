import { describe, expect, it } from "vitest";
import type { DeclaredTool } from "../helpers.js";
import { effectiveLimits } from "../../src/config/index.js";
import { flattenTools } from "../../src/tools/index.js";
import { loadConfigFor } from "../helpers.js";

describe("effective limits precedence", () => {
  it("resolves command > group > defaults > env > built-in", () => {
    const cfg = loadConfigFor(
      [
        "defaults:",
        "  timeout: 10",
        "  max_output: 1000",
        "g:",
        "  timeout: 20",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "    - label: B",
        "      command: echo",
        "      timeout: 30",
        "      max_output: 500",
      ].join("\n"),
    );
    const tools = flattenTools(cfg.groups, cfg.defaults).filter(
      (t): t is DeclaredTool => !("builtin" in t.entry),
    );
    const [a, b] = tools;
    expect(effectiveLimits(a.entry.cmd, a.entry.group, cfg.defaults).timeoutSec).toBe(20);
    expect(effectiveLimits(b.entry.cmd, b.entry.group, cfg.defaults).timeoutSec).toBe(30);
    expect(effectiveLimits(b.entry.cmd, b.entry.group, cfg.defaults).maxChars).toBe(500);
    expect(effectiveLimits({}, { timeout: 20 }, { timeout: 10 }).timeoutSec).toBe(20);
    expect(effectiveLimits({}, {}, { timeout: 10 }).timeoutSec).toBe(10);
  });
});
