// Effective limits: command > group > config defaults > environment >
// built-in. Output_to precedence lives in output.ts.

import type { Limits, NormalizedTruncate } from "./types.js";
import { resolveOutputTo } from "./output.js";

/** The v1.0 shape: keep the first characters, capped by max_output. */
function defaultTruncate(limit: number): NormalizedTruncate {
  return { kind: "default", mode: "start", limit };
}

/** Collapses the output.truncate shorthand and mapping into the effective
 * shape. Invalid forms fall back to the default; validation already
 * reported them as config issues. */
export function normalizeTruncate(raw: unknown, maxChars: number): NormalizedTruncate {
  if (raw === undefined || raw === null || raw === false) return defaultTruncate(maxChars);
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0
      ? { kind: "chars", mode: "end", limit: Math.floor(raw) }
      : defaultTruncate(maxChars);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const s = raw as Record<string, unknown>;
    const limit =
      typeof s.length === "number" && Number.isFinite(s.length) && s.length > 0
        ? Math.floor(s.length)
        : typeof s.bytes === "number" && Number.isFinite(s.bytes) && s.bytes > 0
          ? Math.floor(s.bytes)
          : null;
    if (limit === null) return defaultTruncate(maxChars);
    return {
      kind: s.bytes !== undefined ? "bytes" : "chars",
      mode: s.mode === "start" ? "start" : "end",
      limit,
    };
  }
  return defaultTruncate(maxChars);
}

/**
 * Resolves the effective timeout, output cap, truncation shape, environment
 * inheritance and file output for one run.
 */
export function effectiveLimits(
  cmd: Record<string, any> | null | undefined,
  group: Record<string, any> | null | undefined,
  defaults: Record<string, any> | null | undefined,
): Limits {
  const timeoutSec =
    Number(cmd?.timeout) ||
    Number(group?.timeout) ||
    Number(defaults?.timeout) ||
    Number(process.env.SHELL_RUNNER_TIMEOUT) ||
    120;
  const maxChars =
    Number(cmd?.max_output) ||
    Number(group?.max_output) ||
    Number(defaults?.max_output) ||
    Number(process.env.SHELL_RUNNER_MAX_OUTPUT) ||
    20000;
  // Only a real boolean is honored; anything else falls through and is
  // reported as a config issue by validation.
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const envInherit =
    bool(cmd?.env_inherit) ?? bool(group?.env_inherit) ?? bool(defaults?.env_inherit) ?? true;
  // The truncate shape has no top-level alias: nearest output block wins.
  const rawTruncate =
    cmd?.output?.truncate ?? group?.output?.truncate ?? defaults?.output?.truncate;
  return {
    timeoutSec,
    maxChars,
    envInherit,
    truncate: normalizeTruncate(rawTruncate, maxChars),
    outputTo: resolveOutputTo(cmd, group, defaults),
  };
}
