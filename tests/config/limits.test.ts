import { describe, expect, it } from "vitest";
import type { DeclaredTool } from "../helpers.js";
import { effectiveLimits, normalizeTruncate } from "../../src/config/index.js";
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

describe("normalizeTruncate", () => {
  const fallback = { kind: "default", mode: "start", limit: 100 };

  it("falls back to the default for absent and null-ish values", () => {
    expect(normalizeTruncate(undefined, 100)).toEqual(fallback);
    expect(normalizeTruncate(null, 100)).toEqual(fallback);
    expect(normalizeTruncate(false, 100)).toEqual(fallback);
  });

  it("reads a number as keep-last characters", () => {
    expect(normalizeTruncate(500, 100)).toEqual({ kind: "chars", mode: "end", limit: 500 });
  });

  it("falls back to the default for a non-positive or non-finite number", () => {
    expect(normalizeTruncate(0, 100)).toEqual(fallback);
    expect(normalizeTruncate(-5, 100)).toEqual(fallback);
    expect(normalizeTruncate(Number.POSITIVE_INFINITY, 100)).toEqual(fallback);
  });

  it("reads a mapping of mode and length or bytes", () => {
    expect(normalizeTruncate({ mode: "start", length: 10 }, 100)).toEqual({
      kind: "chars",
      mode: "start",
      limit: 10,
    });
    expect(normalizeTruncate({ mode: "end", length: 7.9 }, 100)).toEqual({
      kind: "chars",
      mode: "end",
      limit: 7,
    });
    expect(normalizeTruncate({ bytes: 4096 }, 100)).toEqual({
      kind: "bytes",
      mode: "end",
      limit: 4096,
    });
  });

  it("falls back to the default when the mapping names no usable limit", () => {
    expect(normalizeTruncate({ mode: "start" }, 100)).toEqual(fallback);
    expect(normalizeTruncate({ length: 0 }, 100)).toEqual(fallback);
    expect(normalizeTruncate({ bytes: -1 }, 100)).toEqual(fallback);
    expect(normalizeTruncate({ length: Number.NaN }, 100)).toEqual(fallback);
  });

  it("falls back to the default for junk types", () => {
    expect(normalizeTruncate("nope", 100)).toEqual(fallback);
    expect(normalizeTruncate([], 100)).toEqual(fallback);
  });
});
