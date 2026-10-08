// Config loading: parse the discovered files, merge the user-global
// companions per group (the trusted store wins), fold the agent file beneath
// both (human groups win, agent groups fill the gaps), validate everything
// into a LoadedConfig, and surface any project config file as a proposal
// (never loaded; applied only by the human-run --merge).

import * as fs from "node:fs";
import { parseYaml } from "../yaml/index.js";
import {
  agentConfigPath,
  configCandidates,
  isFile,
  projectProposalPath,
  storeConfigPath,
} from "./discover.js";
import { normalizeOutputTo } from "./output.js";
import { validateConfig } from "./validate.js";
import { RESERVED_KEYS, type LoadedConfig } from "./types.js";

export {
  agentConfigPath,
  agentsDir,
  homeDir,
  projectDir,
  projectProposalPath,
  projectSlug,
  storeConfigPath,
  storeDir,
} from "./discover.js";

/**
 * Reads a config file: JSON when the name or content says so, else YAML.
 */
export function parseConfigFile(filePath: string): any {
  const text = fs.readFileSync(filePath, "utf8");
  if (/\.json$/i.test(filePath) || text.trim().startsWith("{")) {
    return JSON.parse(text);
  }
  return parseYaml(text);
}

/**
 * Splits a parsed document into its groups and the reserved defaults.
 */
function groupsFromParsed(parsed: any): {
  groups: Record<string, any>;
  defaults: Record<string, any>;
} {
  const defaults =
    parsed && typeof parsed === "object" && parsed.defaults && typeof parsed.defaults === "object"
      ? parsed.defaults
      : {};
  const groups: Record<string, any> = {};
  for (const [k, v] of Object.entries(parsed || {})) {
    if (!RESERVED_KEYS.includes(k)) groups[k] = v;
  }
  return { groups, defaults };
}

/**
 * Validates groups and defaults, wrapping everything into a LoadedConfig.
 */
function finishConfig(
  paths: string[],
  { groups, defaults }: { groups: Record<string, any>; defaults: Record<string, any> },
  extra: {
    explicit?: boolean;
    agentPath?: string | null;
    proposalPath?: string | null;
  } = {},
): LoadedConfig {
  const issues: string[] = [];
  if (defaults && (defaults as any).output_to !== undefined) {
    normalizeOutputTo('config "defaults" "output_to"', (defaults as any).output_to, issues);
  }
  const { issues: groupIssues, validGroups } = validateConfig(groups);
  issues.push(...groupIssues);
  if (validGroups === 0 && !issues.length) {
    issues.push("config declares no commands");
  }
  // finishConfig is only called with at least one path.
  return { path: paths[0], paths, groups, defaults, issues, ...extra };
}

/** The result when a config file exists but cannot be parsed: no commands
 * are exposed and the server reports the failure loudly. */
function parseFatal(file: string, error: Error): LoadedConfig {
  return {
    path: file,
    paths: [file],
    groups: {},
    defaults: {},
    issues: [`config ${file} could not be parsed: ${error.message}`],
    fatal: true,
  };
}

/**
 * First existing candidate of a discovery slot.
 */
function firstFile(paths: string[]): string | null {
  return paths.find((p) => isFile(p)) ?? null;
}

/**
 * Merges the discovered files in precedence order: user-global, then the
 * trusted store (both per group, the store wins), then the agent file
 * beneath (only groups no human config declares). The agent file is folded
 * in with an issue when a human group shadows it, so the doctor report
 * explains missing tools. A project config file, when present, is attached
 * as proposalPath: it is never loaded.
 */
function loadMerged(): LoadedConfig {
  const slots = configCandidates();
  const searched: string[] = [];
  const storeFile = firstFile(slots[1].paths);
  const userFile = firstFile(slots[2].paths);
  for (const slot of [slots[1], slots[2]]) {
    if (slot.paths.length && !firstFile(slot.paths)) {
      searched.push(`${slot.label}: ${slot.paths.join(", ")}`);
    }
  }
  const agentFile = agentConfigPath();
  const hasAgent = agentFile !== null && isFile(agentFile);
  const proposalFile = projectProposalPath();
  if (!storeFile && !userFile && !hasAgent) {
    const missing = missingConfigResult(searched);
    missing.proposalPath = proposalFile;
    return missing;
  }

  const paths: string[] = [];
  let groups: Record<string, any> = {};
  let defaults: Record<string, any> = {};
  for (const file of [userFile, storeFile].filter(Boolean) as string[]) {
    let parsed: any;
    try {
      parsed = parseConfigFile(file);
    } catch (e: any) {
      return parseFatal(file, e);
    }
    const from = groupsFromParsed(parsed);
    paths.unshift(file);
    // Later files (the trusted store) override earlier ones (user-global).
    groups = { ...groups, ...from.groups };
    defaults = { ...defaults, ...from.defaults };
  }

  let agentPath: string | null = null;
  const issues: string[] = [];
  if (hasAgent && agentFile) {
    let parsed: any;
    try {
      parsed = parseConfigFile(agentFile);
    } catch (e: any) {
      return parseFatal(agentFile, e);
    }
    const from = groupsFromParsed(parsed);
    for (const [key, group] of Object.entries(from.groups)) {
      if (groups[key] !== undefined) {
        issues.push(`agent group "${key}" is shadowed by a config group of the same name`);
        continue;
      }
      groups[key] = group;
    }
    agentPath = agentFile;
    paths.push(agentFile);
  }

  const cfg = finishConfig(paths, { groups, defaults }, { agentPath, proposalPath: proposalFile });
  cfg.issues.unshift(...issues);
  return cfg;
}

/** The result when no config file exists anywhere: no commands are exposed,
 * and the issues list where the server looked. */
function missingConfigResult(searched: string[]): LoadedConfig {
  return {
    path: null,
    paths: [],
    groups: {},
    defaults: {},
    issues: [
      `no config file found — create the trusted store with \`--template --save agents\` (writes ${storeConfigPath()}), or set $SHELL_RUNNER_CONFIG; first match wins:`,
      ...searched.map((s) => `  - ${s}`),
    ],
  };
}

/** Finds and loads the effective configuration, merging per the precedence
 * documented in discover.ts. */
export function loadConfig(): LoadedConfig {
  for (const slot of configCandidates()) {
    const file = firstFile(slot.paths);
    if (!file) continue;
    // Slot 1 is explicit and used alone; slots 2+3 (+ the agent file) merge.
    if (slot.slot === 1) {
      let parsed: any;
      try {
        parsed = parseConfigFile(file);
      } catch (e: any) {
        return parseFatal(file, e);
      }
      return finishConfig([file], groupsFromParsed(parsed), {
        explicit: true,
        proposalPath: projectProposalPath(),
      });
    }
    return loadMerged();
  }
  return loadMerged();
}
