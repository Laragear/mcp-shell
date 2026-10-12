// Effective limits: command > group > config defaults > environment >
// built-in. Output_to precedence lives in output.ts.

import type { Limits } from "./types.js";
import { resolveOutputTo } from "./output.js";

/**
 * Resolves the effective timeout, output cap and file output for one run.
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
  return { timeoutSec, maxChars, envInherit, outputTo: resolveOutputTo(cmd, group, defaults) };
}
