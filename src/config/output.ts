// The output_to sub-domain: opt-in writing of raw output to a file.
// Disabled by default, because whatever a command prints may include secrets,
// and a file outlives the truncated tool result. Owns both the normalization
// of untrusted specs and the precedence resolution.

import { commandPlaceholders } from "../support.js";
import type { CommandSpec, GroupSpec, NormalizedOutputTo } from "./types.js";

/** Validates the mapping form of output_to into `out`; false when invalid
 * (the problem is already pushed to issues). */
function fillOutputToMapping(
  where: string,
  s: Record<string, unknown>,
  out: NormalizedOutputTo,
  issues: string[],
): boolean {
  const hasPath = typeof s.path === "string" && !!(s.path as string).trim();
  const hasDir = typeof s.dir === "string" && !!(s.dir as string).trim();
  if (hasPath && hasDir) {
    issues.push(`${where}: "output_to" accepts "path" or "dir", not both`);
    return false;
  }
  if (!hasPath && !hasDir) {
    issues.push(`${where}: "output_to" mapping needs a non-empty "path" or "dir"`);
    return false;
  }
  if (s.allow_agent !== undefined && typeof s.allow_agent !== "boolean") {
    issues.push(`${where}: "output_to.allow_agent" must be a boolean`);
    return false;
  }
  if (s.allow_agent === true && !hasDir) {
    issues.push(`${where}: "output_to" with "allow_agent: true" needs a "dir"`);
    return false;
  }
  if (s.append !== undefined && typeof s.append !== "boolean") {
    issues.push(`${where}: "output_to.append" must be a boolean`);
    return false;
  }
  if (s.stderr !== undefined && typeof s.stderr !== "boolean") {
    issues.push(`${where}: "output_to.stderr" must be a boolean`);
    return false;
  }
  out.path = hasPath ? (s.path as string) : null;
  out.dir = hasDir ? (s.dir as string) : null;
  out.allow_agent = s.allow_agent === true;
  out.append = s.append === true;
  out.stderr = s.stderr === true;
  return true;
}

/** Validates one output_to spec (from defaults, a group or a command) and
 * returns a normalized descriptor, or null when disabled/invalid. Every
 * problem is pushed to issues with its config location. */
export function normalizeOutputTo(
  where: string,
  spec: unknown,
  issues: string[],
): NormalizedOutputTo | null {
  if (spec === undefined || spec === null || spec === false) return null;
  const out: NormalizedOutputTo = {
    append: false,
    stderr: false,
    allow_agent: false,
    path: null,
    dir: null,
  };
  let valid: boolean;
  if (typeof spec === "string") {
    valid = !!spec.trim();
    if (!valid) issues.push(`${where}: "output_to" must be a non-empty path string or a mapping`);
    else out.path = spec;
  } else if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    valid = fillOutputToMapping(where, spec as Record<string, unknown>, out, issues);
  } else {
    valid = false;
    issues.push(
      `${where}: "output_to" must be false, a path string, or a mapping of {path|dir, allow_agent, append, stderr}`,
    );
  }
  if (!valid) return null;
  for (const ph of commandPlaceholders(out.path || out.dir)) {
    if (ph !== "command" && ph !== "group") {
      issues.push(
        `${where}: "output_to" placeholder {${ph}} is not supported (only {command} and {group})`,
      );
      return null;
    }
  }
  return out;
}

/**
 * Nearest definition wins wholesale: a command-level "output_to: false" disables an enabled group, and vice versa.
 */
export function resolveOutputTo(
  cmd: CommandSpec | Record<string, any> | null | undefined,
  group: GroupSpec | Record<string, any> | null | undefined,
  defaults: Record<string, any> | null | undefined,
): NormalizedOutputTo | null {
  const raw: unknown =
    cmd && (cmd as any).output_to !== undefined
      ? (cmd as any).output_to
      : group && (group as any).output_to !== undefined
        ? (group as any).output_to
        : defaults && (defaults as any).output_to !== undefined
          ? (defaults as any).output_to
          : undefined;
  if (raw === undefined) return null;
  // Invalid specs were already reported as config issues; treat as off here.
  return normalizeOutputTo("output_to", raw, []);
}
