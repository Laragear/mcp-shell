// One group rendered as a fill-in YAML mapping: header keys, the command
// list, or the commented starter command when the group has none.

import { COMMAND_REFERENCE, emitCommand, emitEnv, yamlScalar } from "./yaml.js";

/**
 * Emits one group as a fill-in YAML mapping.
 */
export function emitGroupTemplate(groupKey: string, group: any): string[] {
  const out: string[] = [];
  const opt = (key: string, value: unknown, comment: string) => {
    if (value === undefined) return;
    out.push(`  # ${key}: ${yamlScalar(value)}   # ${comment}`);
  };
  out.push(`${yamlScalar(groupKey)}:`);
  out.push(`  description: ${yamlScalar(group.description || "What this group does")}`);
  out.push(`  trigger: ${yamlScalar(group.trigger || "When the agent should use these tools")}`);
  if (!Object.keys(group.env || {}).length) {
    out.push(`  # env:                      # propagated to every command below`);
    out.push(`  #   CI: true`);
  }
  emitEnv(out, group.env, "  ");
  opt("timeout", group.timeout, "seconds, group-wide default");
  opt("cwd", group.cwd, "group-wide default working directory");
  out.push(`  commands:`);
  const commands = Array.isArray(group.commands)
    ? group.commands.filter((c: any) => c && typeof c === "object")
    : [];
  for (const cmd of commands) emitCommand(out, cmd);
  if (!commands.length) {
    out.push(`    - label: Run all tests`);
    out.push(`      command: npm test`);
    out.push(`      args: true`);
    out.push(...COMMAND_REFERENCE);
  }
  return out;
}
