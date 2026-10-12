// The agent-owned config file (~/.agents/mcp-shell/<project>/agent.yaml,
// next to the trusted store): commands the agent proposed and the human
// approved over MCP elicitation. Human config files are never rewritten; the
// agent file merges beneath them per group (human groups win wholesale).
// Owns the strict YAML emitter, the validated upsert/remove operations and
// the serialized atomic writes.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseYaml } from "../yaml/index.js";
import { validateConfig } from "./validate.js";
import { RESERVED_KEYS } from "./types.js";
import { yamlScalar } from "../support.js";

/** A value scalar: numbers and booleans go out bare so they parse back as
 * themselves; strings go through the quoting helper. */
function scalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return yamlScalar(v);
}

/**
 * Serializes the whole document: the groups, plus the optional reserved
 * defaults block (the trusted store carries one; the agent file never does).
 */
export function emitAgentGroups(
  groups: Record<string, any>,
  defaults?: Record<string, any>,
): string {
  const lines: string[] = [];
  if (defaults && Object.keys(defaults).length) {
    lines.push("defaults:");
    for (const [k, v] of Object.entries(defaults)) {
      lines.push(`  ${yamlScalar(k)}: ${scalar(v)}`);
    }
  }
  for (const [key, group] of Object.entries(groups)) {
    if (lines.length) lines.push("");
    lines.push(`${yamlScalar(key)}:`);
    if (group?.description) lines.push(`  description: ${yamlScalar(group.description)}`);
    if (group?.trigger) lines.push(`  trigger: ${yamlScalar(group.trigger)}`);
    if (group?.env && Object.keys(group.env).length) {
      lines.push("  env:");
      for (const [k, v] of Object.entries(group.env)) {
        lines.push(`    ${yamlScalar(k)}: ${scalar(v)}`);
      }
    }
    lines.push("  commands:");
    for (const cmd of group?.commands ?? []) lines.push(...emitAgentCommand(cmd));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Serializes one command as a block-sequence entry.
 */
function emitAgentCommand(cmd: any): string[] {
  const out = [
    `    - label: ${yamlScalar(cmd.label)}`,
    `      command: ${emitMultiline(cmd.command, 6)}`,
  ];
  if (cmd.description !== undefined) out.push(`      description: ${yamlScalar(cmd.description)}`);
  if (cmd.args === true) out.push("      args: true");
  else if (Array.isArray(cmd.args)) {
    out.push("      args:");
    for (const spec of cmd.args) {
      out.push(`        - name: ${yamlScalar(spec.name)}`);
      if (spec.description !== undefined) {
        out.push(`          description: ${yamlScalar(spec.description)}`);
      }
      if (spec.required === true) out.push("          required: true");
      if (spec.default !== undefined) out.push(`          default: ${scalar(spec.default)}`);
      if (spec.prefix !== undefined) out.push(`          prefix: ${yamlScalar(spec.prefix)}`);
      if (spec.suffix !== undefined) out.push(`          suffix: ${yamlScalar(spec.suffix)}`);
    }
  }
  if (cmd.env && Object.keys(cmd.env).length) {
    out.push("      env:");
    for (const [k, v] of Object.entries(cmd.env)) {
      out.push(`        ${yamlScalar(k)}: ${scalar(v)}`);
    }
  }
  if (cmd.timeout !== undefined) out.push(`      timeout: ${scalar(cmd.timeout)}`);
  if (cmd.cwd !== undefined) out.push(`      cwd: ${yamlScalar(cmd.cwd)}`);
  if (cmd.env_inherit !== undefined) out.push(`      env_inherit: ${scalar(cmd.env_inherit)}`);
  if (cmd.pipe !== undefined) out.push(`      pipe: ${yamlScalar(cmd.pipe)}`);
  if (cmd.check && Object.keys(cmd.check).length) {
    out.push("      check:");
    for (const [rule, value] of Object.entries(cmd.check)) {
      out.push(
        `        ${rule}: ${Array.isArray(value) ? `[${value.map(scalar).join(", ")}]` : scalar(value)}`,
      );
    }
  }
  if (cmd.max_output !== undefined) out.push(`      max_output: ${scalar(cmd.max_output)}`);
  if (cmd.read_only === true) out.push("      read_only: true");
  if (cmd.destructive === true) out.push("      destructive: true");
  if (cmd.output_to !== undefined) {
    out.push(
      `      output_to: ${
        typeof cmd.output_to === "object" ? emitFlowMapping(cmd.output_to) : scalar(cmd.output_to)
      }`,
    );
  }
  return out;
}

/** A string as a plain or quoted scalar, or a "|-" block when it spans lines.
 * The block body sits two columns deeper than the key, as the parser needs. */
function emitMultiline(text: string, indent: number): string {
  if (!text.includes("\n")) return yamlScalar(text);
  const pad = " ".repeat(indent + 2);
  const body = text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => `${pad}${l}`)
    .join("\n");
  return `|-\n${body}`;
}

/** A one-line {k: v} flow mapping, for compact single-key-per-line values. */
function emitFlowMapping(map: Record<string, unknown>): string {
  const inner = Object.entries(map)
    .map(([k, v]) => `${yamlScalar(k)}: ${scalar(v)}`)
    .join(", ");
  return `{ ${inner} }`;
}

/**
 * The parsed groups of the agent file, or an empty record when it does not
 * exist yet. Throws on unparseable content (the caller reports it).
 */
export function readAgentGroups(filePath: string): Record<string, any> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  let parsed: any;
  try {
    parsed = parseYaml(text);
  } catch (e: any) {
    throw new Error(`agent config ${filePath} could not be parsed: ${e.message}`);
  }
  const groups: Record<string, any> = {};
  if (!parsed) return groups;
  for (const [k, v] of Object.entries(parsed)) {
    if (!RESERVED_KEYS.includes(k)) groups[k] = v;
  }
  return groups;
}

/**
 * Atomic owner-only write: tmp file plus rename, so a concurrent reload
 * never observes a torn file.
 */
export function writeAgentGroups(
  filePath: string,
  groups: Record<string, any>,
  defaults?: Record<string, any>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, emitAgentGroups(groups, defaults), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Validates a proposal against the agent file's existing groups, with the
 * command replacing any same-named one. Returns every config issue; an
 * empty list means the write would be valid.
 */
export function validateAgentProposal(
  filePath: string,
  groupKey: string,
  meta: { description?: string; trigger?: string },
  cmd: Record<string, unknown>,
): string[] {
  const groups = readAgentGroups(filePath);
  const group = groups[groupKey] ?? { commands: [] };
  const commands: any[] = (Array.isArray(group.commands) ? group.commands : []).filter(
    (c: any) => !c || c.label !== cmd.label,
  );
  commands.push(cmd);
  return validateConfig({ ...groups, [groupKey]: { ...group, ...meta, commands } }).issues;
}

/**
 * Inserts or replaces one command by name inside its group; the group is
 * created when absent. Returns whether an existing command was replaced.
 * Throws with the config issues when the proposal is invalid.
 */
export function upsertAgentCommand(
  filePath: string,
  groupKey: string,
  meta: { description?: string; trigger?: string },
  cmd: Record<string, unknown>,
): { replaced: boolean } {
  const issues = validateAgentProposal(filePath, groupKey, meta, cmd);
  if (issues.length) throw new Error(issues.join("\n"));
  const groups = readAgentGroups(filePath);
  const group = groups[groupKey] ?? { commands: [] };
  const commands: any[] = Array.isArray(group.commands) ? [...group.commands] : [];
  const at = commands.findIndex((c) => c && c.label === cmd.label);
  const replaced = at >= 0;
  if (replaced) commands[at] = cmd;
  else commands.push(cmd);
  groups[groupKey] = { ...group, ...meta, commands };
  writeAgentGroups(filePath, groups);
  return { replaced };
}

/**
 * Removes one command from the agent file. False when the group or command
 * is not there (the caller refuses: human commands are not removable here).
 */
export function removeAgentCommand(filePath: string, groupKey: string, label: string): boolean {
  const groups = readAgentGroups(filePath);
  const commands: any[] | undefined = groups[groupKey]?.commands;
  if (!Array.isArray(commands)) return false;
  const at = commands.findIndex((c) => c && c.label === label);
  if (at < 0) return false;
  commands.splice(at, 1);
  if (commands.length) groups[groupKey].commands = commands;
  else delete groups[groupKey];
  writeAgentGroups(filePath, groups);
  return true;
}

// Read-modify-write of the agent file is serialized: tool calls may overlap
// (a run reloading the config while a proposal is being written).
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs fn when every previous agent-file operation finished; failures do
 * not break the chain.
 */
export function withAgentLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
