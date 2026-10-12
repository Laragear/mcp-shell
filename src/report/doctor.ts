// The list_commands doctor report: what is loaded, what will run, and what
// is wrong — so one call answers "what happens if I run this?".

import type { CommandSpec, GroupSpec, LoadedConfig } from "../config/index.js";
import { effectiveLimits, readAgentGroups, resolveOutputTo } from "../config/index.js";
import { flattenTools, previewCommandline } from "../tools/index.js";

/**
 * The group keys declared by the agent file (empty when unreadable; the
 * parse failure is already reported as a config issue).
 */
function agentGroupKeys(cfg: LoadedConfig): Set<string> {
  if (!cfg.agentPath) return new Set();
  try {
    return new Set(Object.keys(readAgentGroups(cfg.agentPath)));
  } catch {
    return new Set();
  }
}

/** The "Config:" / "Merge:" / "Defaults:" header lines plus every config
 * issue. */
function reportHeader(cfg: LoadedConfig, lines: string[]): { timeoutSec: number } {
  const { timeoutSec, maxChars } = effectiveLimits(null, null, cfg.defaults);
  const humanPaths = cfg.paths.filter((p) => p !== cfg.agentPath);
  if (cfg.agentPath && !humanPaths.length) {
    lines.push(`Config: ${cfg.agentPath} (agent-approved commands; no human config file found)`);
  } else {
    const base = humanPaths.length ? humanPaths.join(" + ") : "none found — no commands exposed";
    lines.push(`Config: ${base}${cfg.agentPath ? ` + ${cfg.agentPath}` : ""}`);
  }
  if (humanPaths.length === 2) {
    lines.push(
      `Merge: trusted store groups override same-named user-global groups; defaults merge with store precedence.`,
    );
  }
  if (cfg.agentPath) {
    lines.push(`Agent file: ${cfg.agentPath} (commands the human approved over elicitation)`);
  }
  if (cfg.proposalPath) {
    lines.push(
      `Proposal: ${cfg.proposalPath} (NOT loaded; review it into the trusted store with \`--merge\`)`,
    );
  }
  lines.push(
    `Defaults: timeout=${timeoutSec}s, max_output=${maxChars} chars (precedence: command > group > config defaults > env > built-in)`,
  );
  if (cfg.issues.length) {
    lines.push(`\nConfig issues (${cfg.issues.length}) — affected commands are NOT exposed:`);
    for (const issue of cfg.issues) lines.push(`  ! ${issue}`);
  } else {
    lines.push("Config issues: none");
  }
  return { timeoutSec };
}

/** The extras appended to a command's line: argument mode, pipe stage,
 * file output, check rules and an effective timeout that differs from the
 * default. */
function commandExtras(cmd: CommandSpec, group: GroupSpec, cfg: LoadedConfig): string[] {
  const extras: string[] = [];
  if (typeof cmd.pipe === "string" && cmd.pipe.trim()) extras.push(`pipe: ${cmd.pipe}`);
  const outDesc = resolveOutputTo(cmd, group, cfg.defaults);
  if (outDesc) {
    extras.push(
      `output to: ${outDesc.path || outDesc.dir}${outDesc.allow_agent ? " (agent-decided)" : ""}`,
    );
  }
  if (cmd.check) {
    extras.push(
      "check: " +
        Object.entries(cmd.check)
          .map(([k, v]) => `${k}=${JSON.stringify(Array.isArray(v) ? v : [v])}`)
          .join(", "),
    );
  }
  return extras;
}

/** One group heading and its command lines. Each group is flattened alone so
 * names stay unsuffixed when a cross-group collision would rename them. */
function reportGroup(
  groupKey: string,
  group: GroupSpec,
  cfg: LoadedConfig,
  timeoutSec: number,
  lines: string[],
  agentGroups: Set<string> = new Set(),
): void {
  lines.push(`\n## ${groupKey}${agentGroups.has(groupKey) ? " (agent-proposed)" : ""}`);
  if (group.description) lines.push(group.description);
  if (group.trigger) lines.push(`Trigger when: ${group.trigger}`);
  if (group.timeout || group.cwd || (group as any).output_to !== undefined) {
    lines.push(
      `Group settings: ${[
        group.timeout ? `timeout=${group.timeout}s` : null,
        group.cwd ? `cwd=${group.cwd}` : null,
        (group as any).output_to !== undefined
          ? `output_to=${JSON.stringify((group as any).output_to)}`
          : null,
      ]
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  const groupTools = flattenTools({ [groupKey]: group }, cfg.defaults);
  for (const t of groupTools) {
    if (!("cmd" in t.entry)) continue;
    const cmd = t.entry.cmd;
    const extras = commandExtras(cmd, group, cfg);
    if (t.entry.args.mode !== "none") extras.unshift("accepts arguments");
    const limits = effectiveLimits(cmd, group, cfg.defaults);
    if (limits.timeoutSec !== timeoutSec) extras.push(`timeout=${limits.timeoutSec}s`);
    if (limits.truncate.kind !== "default") {
      extras.push(
        `truncate: ${limits.truncate.mode === "end" ? "last" : "first"} ` +
          `${limits.truncate.limit} ${limits.truncate.kind === "bytes" ? "bytes" : "chars"}`,
      );
    }
    lines.push(
      `- ${t.schema.name}: \`${previewCommandline(t.entry)}\`${extras.length ? ` — ${extras.join("; ")}` : ""}`,
    );
  }
}

/**
 * The full doctor report for the loaded configuration.
 */
export function doctorReport(cfg: LoadedConfig): string {
  const lines: string[] = [];
  const { timeoutSec } = reportHeader(cfg, lines);
  const agentGroups = agentGroupKeys(cfg);
  const tools = flattenTools(cfg.groups, cfg.defaults);
  lines.push(
    `\nBuilt-in tools: ${tools
      .filter((t) => "builtin" in t.entry)
      .map((t) => t.schema.name)
      .join(", ")}`,
  );
  for (const [groupKey, group] of Object.entries(cfg.groups || {})) {
    reportGroup(groupKey, group as GroupSpec, cfg, timeoutSec, lines, agentGroups);
  }
  return lines.join("\n");
}
