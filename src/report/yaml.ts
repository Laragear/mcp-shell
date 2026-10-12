// YAML building blocks for the config template: scalar quoting and the
// fill-in blocks of one command.

import { CHECK_RULES } from "../config/index.js";
import { argMode } from "../tools/index.js";
import { yamlScalar } from "../support.js";

export { yamlScalar };

// The commented reference block shown when a group declares no commands.
export const COMMAND_REFERENCE = [
  `      # Full reference of optional command keys:`,
  `      # description: refines the tool description`,
  `      # args: false | true | list of {name, description, required, default, prefix, suffix}`,
  `      # args: true receives a list of strings, each shell-quoted separately before appending`,
  `      # command may contain {placeholders} filled by named args: eslint {file}`,
  `      # prefix/suffix glue literal text around an argument value: prefix: "--memory "`,
  `      # env: { KEY: value } — inline mapping, or nested keys; values may use \${VAR}`,
  `      # env_inherit: false — run only with the declared env (PATH and HOME survive)`,
  `      # timeout: 60   # seconds`,
  `      # cwd: ./subdir`,
  `      # pipe: <command> — stdout piped through it; exit code stays the command's`,
  `      # check: {contains|not_contains|regex|not_regex} — success rules on output`,
  `      # max_output: 5000   # output truncation limit in chars`,
  `      # output_to: logs/{command}.log — opt-in raw output to a file ({command}, {group} placeholders)`,
  `      #   or a mapping: {dir, allow_agent, append, stderr} — see config_template output`,
  `      # output: {to: ..., pipe: ...} — same as output_to and pipe under one key`,
  `      # output.truncate: 5000 — keep the last N chars; or {mode: start|end, length|bytes}`,
  `      # read_only: true — enforced: no env, pipe or output_to allowed on the command`,
  `      # destructive: true — enforced: calls need acknowledge_destructive: true`,
];

/**
 * Emits the commented output_to reference block for one command.
 */
function emitOutputToReference(out: string[]): void {
  out.push(
    `      # output_to: logs/{command}.log   # always write raw stdout here (owner-only perms)`,
  );
  out.push(`      # output_to:`);
  out.push(
    `      #   dir: logs/                    # agent-decided: the agent may opt in per call`,
  );
  out.push(`      #   allow_agent: true             # WARNING: output can carry secrets to disk`);
  out.push(`      #   append: false                 # truncate per run (true: keep previous runs)`);
  out.push(`      #   stderr: false                 # capture stdout only (true: stderr too)`);
}

/** Emits the `env:` block of a group or command; nothing when there is no
 * env (callers render their own commented hint when they want one). */
export function emitEnv(
  out: string[],
  env: Record<string, unknown> | undefined,
  indent: string,
): void {
  const entries = Object.entries(env || {});
  if (!entries.length) return;
  out.push(`${indent}env:`);
  for (const [k, v] of entries) out.push(`${indent}  ${yamlScalar(k)}: ${yamlScalar(v)}`);
}

/** Emits the args block of one command: free-form, named list, or the
 * commented default. */
function emitArgs(out: string[], cmd: any): void {
  const args = argMode(cmd);
  if (args.mode === "free") {
    out.push(
      `      args: true   # accepts free-form arguments as a list of strings, quoted separately`,
    );
  } else if (args.mode === "named") {
    out.push(`      args:`);
    for (const s of args.specs) {
      out.push(`        - name: ${yamlScalar(s.name)}`);
      out.push(`          description: ${yamlScalar(s.description)}`);
      if (s.required) out.push(`          required: true`);
      if (s.default !== undefined) out.push(`          default: ${yamlScalar(s.default)}`);
      if (s.prefix !== undefined) out.push(`          prefix: ${yamlScalar(s.prefix)}`);
      if (s.suffix !== undefined) out.push(`          suffix: ${yamlScalar(s.suffix)}`);
    }
  } else {
    out.push(`      # args: false   # default: runs exactly as written, no arguments`);
  }
}

/**
 * Emits the check block of one command, or the commented example.
 */
function emitCheck(out: string[], cmd: any): void {
  if (cmd.check && typeof cmd.check === "object") {
    out.push(`      check:`);
    for (const rule of CHECK_RULES) {
      const v = (cmd.check as any)[rule];
      if (v === undefined) continue;
      if (Array.isArray(v)) out.push(`        ${rule}: [${v.map(yamlScalar).join(", ")}]`);
      else out.push(`        ${rule}: ${yamlScalar(v)}`);
    }
  } else {
    out.push(`      # check:`);
    out.push(`      #   contains: [OK]`);
    out.push(`      #   not_contains: [FAIL]`);
    out.push(`      #   regex: ['\\d+ passed']`);
  }
}

/**
 * Emits one command of a group as a fill-in YAML sequence entry.
 */
export function emitCommand(out: string[], cmd: any): void {
  out.push(`    - label: ${yamlScalar(cmd.label || "New command")}`);
  out.push(`      command: ${yamlScalar(cmd.command || "echo fill-me-in")}`);
  emitArgs(out, cmd);
  if (cmd.description !== undefined) out.push(`      description: ${yamlScalar(cmd.description)}`);
  if (cmd.timeout !== undefined) out.push(`      timeout: ${yamlScalar(cmd.timeout)}`);
  if (cmd.cwd !== undefined) out.push(`      cwd: ${yamlScalar(cmd.cwd)}`);
  emitEnv(out, cmd.env, "      ");
  if (typeof cmd.pipe === "string" && cmd.pipe.trim()) {
    out.push(
      `      pipe: ${yamlScalar(cmd.pipe)}   # stdout piped through this; exit code stays the command's`,
    );
  } else {
    out.push(`      # pipe: <command>   # pipe stdout through a command (e.g. tail -20)`);
  }
  emitCheck(out, cmd);
  if (cmd.max_output !== undefined) out.push(`      max_output: ${yamlScalar(cmd.max_output)}`);
  emitOutputToReference(out);
  out.push(
    `      # read_only: ${cmd.read_only === true ? "true" : "false"}   # enforced: no env, pipe or output_to`,
  );
  out.push(
    `      # destructive: ${cmd.destructive === true ? "true" : "false"}  # enforced: calls need acknowledge_destructive: true`,
  );
}
