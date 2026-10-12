// Validation of the untrusted config: every problem is reported (with
// group/command context) instead of being silently skipped. Invalid commands
// are excluded from the tool list.

import { commandPlaceholders, compileMultilineRegex } from "../support.js";
import { normalizeOutputTo } from "./output.js";
import { CHECK_RULES } from "./types.js";

/** Validates the check rules of a command: every present rule must be known,
 * and regex patterns must compile. False when the check is unusable. */
function validateCheckSpec(where: string, spec: unknown, issues: string[]): boolean {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    issues.push(`${where}: "check" must be a mapping of ${CHECK_RULES.join(", ")}`);
    return false;
  }
  let ok = true;
  for (const key of Object.keys(spec)) {
    if (!CHECK_RULES.includes(key)) {
      issues.push(`${where}: unknown check rule "${key}" (allowed: ${CHECK_RULES.join(", ")})`);
      ok = false;
    }
  }
  for (const key of CHECK_RULES) {
    const v = (spec as Record<string, unknown>)[key];
    if (v === undefined) continue;
    for (const p of Array.isArray(v) ? v : [v]) {
      if (!key.endsWith("regex")) continue;
      const compiled = compileMultilineRegex(String(p));
      if ("error" in compiled) {
        issues.push(`${where}: invalid ${key} ${JSON.stringify(String(p))}: ${compiled.error}`);
        ok = false;
      }
    }
  }
  return ok;
}

/** Validates the declared args list and returns the argument names, or null
 * when an entry is invalid (the caller then skips the remaining checks). */
function validateArgList(
  where: string,
  name: string,
  args: unknown[],
  issues: string[],
): string[] | null {
  const names: string[] = [];
  let ok = true;
  for (const a of args) {
    const arg = a as { name?: unknown } | null | undefined;
    if (!arg || typeof arg !== "object" || typeof arg.name !== "string" || !arg.name.trim()) {
      issues.push(`${where} "${name}": every entry in "args" needs a non-empty "name"`);
      return null;
    }
    if (names.includes(arg.name)) {
      issues.push(`${where} "${name}": duplicate argument name "${arg.name}"`);
      return null;
    }
    for (const key of ["prefix", "suffix"] as const) {
      const v = (arg as Record<string, unknown>)[key];
      if (v !== undefined && typeof v !== "string") {
        issues.push(`${where} "${name}": argument "${arg.name}" "${key}" must be a string`);
        ok = false;
      }
    }
    names.push(arg.name);
  }
  return ok ? names : null;
}

/** Reports every {placeholder} in the command line that the declared args
 * cannot fill, including the "args: true" ambiguity. */
function validatePlaceholders(
  where: string,
  name: string,
  cmdText: string,
  args: unknown,
  argNames: string[],
  issues: string[],
): void {
  const placeholders = commandPlaceholders(cmdText);
  if (!placeholders.length) return;
  const named = placeholders.map((p) => `{${p}}`).join(", ");
  if (args === true) {
    issues.push(
      `${where} "${name}": command uses ${named} but "args: true" is ambiguous; declare a named args list instead`,
    );
  } else if (!Array.isArray(args)) {
    issues.push(
      `${where} "${name}": command uses placeholder ${named} but declares no named arguments`,
    );
  } else {
    for (const ph of placeholders) {
      if (!argNames.includes(ph)) {
        issues.push(`${where} "${name}": placeholder {${ph}} has no matching named argument`);
      }
    }
  }
}

/** Validates the keys a command and a group share: timeout, cwd, env. */
function validateSharedFields(where: string, spec: any, issues: string[]): void {
  if (spec.timeout !== undefined && !Number(spec.timeout)) {
    issues.push(`${where}: "timeout" must be a positive number of seconds`);
  }
  if (spec.cwd !== undefined && typeof spec.cwd !== "string") {
    issues.push(`${where}: "cwd" must be a string`);
  }
  if (
    spec.env !== undefined &&
    (typeof spec.env !== "object" || spec.env === null || Array.isArray(spec.env))
  ) {
    issues.push(`${where}: "env" must be a mapping of NAME: value`);
  }
  if (spec.env_inherit !== undefined && typeof spec.env_inherit !== "boolean") {
    issues.push(`${where}: "env_inherit" must be true or false`);
  }
}

/** Validates one command spec. False when the command is unusable and must
 * be excluded from the tool list. */
function validateCommand(where: string, cmd: any, issues: string[]): boolean {
  const label = cmd && typeof cmd === "object" && cmd.label ? ` (label: "${cmd.label}")` : "";
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) {
    issues.push(`${where}${label}: must be a mapping`);
    return false;
  }
  if (typeof cmd.label !== "string" || !cmd.label.trim()) {
    issues.push(`${where}${label}: missing non-empty "label"`);
    return false;
  }
  if (typeof cmd.command !== "string" || !cmd.command.trim()) {
    issues.push(`${where} "${cmd.label}": missing non-empty "command"`);
    return false;
  }
  if (!validateArgsField(where, cmd, issues)) return false;
  validateSharedFields(`${where} "${cmd.label}"`, cmd, issues);
  if (cmd.pipe !== undefined && (typeof cmd.pipe !== "string" || !cmd.pipe.trim())) {
    issues.push(`${where} "${cmd.label}": "pipe" must be a non-empty command string`);
  }
  if (cmd.output_to !== undefined) {
    normalizeOutputTo(`${where} "${cmd.label}" "output_to"`, cmd.output_to, issues);
  }
  if (cmd.check !== undefined && !validateCheckSpec(`${where} "${cmd.label}"`, cmd.check, issues)) {
    return false;
  }
  return true;
}

/** Validates the "args" field shape and placeholder coverage; false when the
 * declaration itself is invalid. */
function validateArgsField(where: string, cmd: any, issues: string[]): boolean {
  const args = cmd.args;
  if (args !== undefined && args !== true && args !== false && !Array.isArray(args)) {
    issues.push(
      `${where} "${cmd.label}": "args" must be true, false, or a list of {name, description, required, default} mappings`,
    );
    return false;
  }
  const argNames = Array.isArray(args) ? validateArgList(where, cmd.label, args, issues) : [];
  if (argNames === null) return false;
  validatePlaceholders(where, cmd.label, cmd.command, args, argNames, issues);
  return true;
}

/** Validates the group-level keys of one group. False when the group itself
 * is unusable (its commands, if any, are then not inspected). */
function validateGroup(groupKey: string, group: any, issues: string[]): boolean {
  const g = `group "${groupKey}"`;
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    issues.push(`${g}: must be a mapping with a "commands" list`);
    return false;
  }
  if (!Array.isArray(group.commands)) {
    issues.push(`${g}: missing "commands" list — group declares no commands`);
    return false;
  }
  validateSharedFields(g, group, issues);
  if (group.output_to !== undefined) {
    normalizeOutputTo(`${g} "output_to"`, group.output_to, issues);
  }
  return true;
}

/** Validates every group and command; returns all issues and the number of
 * groups that expose at least one valid command. */
export function validateConfig(groups: Record<string, any>): {
  issues: string[];
  validGroups: number;
} {
  const issues: string[] = [];
  let validGroups = 0;
  for (const [groupKey, group] of Object.entries(groups || {})) {
    if (!validateGroup(groupKey, group, issues)) continue;
    const g = `group "${groupKey}"`;
    const commands: any[] = group.commands;
    let groupValid = 0;
    commands.forEach((cmd, idx) => {
      const where = commands.length > 1 ? `${g} command #${idx + 1}` : `${g} command`;
      if (validateCommand(where, cmd, issues)) groupValid++;
    });
    if (groupValid > 0) validGroups++;
  }
  return { issues, validGroups };
}
