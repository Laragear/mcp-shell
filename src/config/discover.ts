// Config discovery: where config files may live, and which exist.
//
// Nothing inside the project tree is ever loaded as authoritative config:
// whoever (or whatever agent) can write there must not be able to declare
// commands. The trusted locations are all under the user's home:
//
//   1. $SHELL_RUNNER_CONFIG — explicit path (CI, scripting); used alone
//   2. ~/.agents/mcp-shell/<project-slug>/commands.yaml — trusted
//      per-project store (YAML only), reviewed in with `--merge`
//   3. ~/.agents/shell-runner.{yaml,yml,json} — user-global, merged per group
//
// A <project>/.agents/shell-runner.{yaml,yml,json} file is at most a
// proposal: reported by the doctor, applied only by the human-run --merge.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PRIMARY_DIR = ".agents";
const CONFIG_EXTENSIONS = ["yaml", "yml", "json"];
const STORE_ROOT = ["mcp-shell"] as const;
/** The trusted store file of one project (YAML only: one file, no variants). */
export const STORE_CONFIG_FILE = "commands.yaml";
/** The agent-owned companion file: commands approved over elicitation. */
export const AGENT_CONFIG_FILE = "agent.yaml";

/**
 * The user's home directory, overridable for tests and sandboxes.
 */
export function homeDir(): string {
  return process.env.SHELL_RUNNER_HOME || os.homedir();
}

/**
 * The project directory: $SHELL_RUNNER_PROJECT_DIR or the current one.
 */
export function projectDir(): string {
  return process.env.SHELL_RUNNER_PROJECT_DIR || process.cwd();
}

/**
 * The primary `.agents` directory of the project or the user home.
 */
export function agentsDir(location: "project" | "user"): string {
  return path.join(location === "project" ? projectDir() : homeDir(), PRIMARY_DIR);
}

/**
 * The trusted store directory of this project under the user's home:
 * readable (the resolved path, lowercased, compacted to dashes) and unique
 * (the first 8 hex of a sha1 of the raw resolved path).
 */
export function projectSlug(): string {
  const resolved = path.resolve(projectDir());
  const stem = `${resolved.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${stem}-${hash}`;
}

/**
 * The trusted store directory of this project.
 */
export function storeDir(): string {
  return path.join(homeDir(), PRIMARY_DIR, ...STORE_ROOT, projectSlug());
}

/**
 * The trusted per-project config file inside the store.
 */
export function storeConfigPath(): string {
  return path.join(storeDir(), STORE_CONFIG_FILE);
}

/**
 * The agent file where approved proposals are stored, next to the trusted
 * store; null when the explicit $SHELL_RUNNER_CONFIG is in play (it is used
 * alone).
 */
export function agentConfigPath(): string | null {
  if (process.env.SHELL_RUNNER_CONFIG) return null;
  return path.join(storeDir(), AGENT_CONFIG_FILE);
}

/**
 * A project config file is a proposal, never loaded. Returns its path when
 * one exists (first existing extension wins), null otherwise or when the
 * explicit $SHELL_RUNNER_CONFIG is in play.
 */
export function projectProposalPath(): string | null {
  if (process.env.SHELL_RUNNER_CONFIG) return null;
  for (const ext of CONFIG_EXTENSIONS) {
    const candidate = path.join(agentsDir("project"), `shell-runner.${ext}`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The config file candidates in precedence order: slot 1 is used alone,
 * slots 2 and 3 merge.
 */
export function configCandidates(): Array<{ slot: number; label: string; paths: string[] }> {
  const userCandidates = () =>
    CONFIG_EXTENSIONS.map((ext) => path.join(agentsDir("user"), `shell-runner.${ext}`));
  return [
    {
      slot: 1,
      label: "$SHELL_RUNNER_CONFIG (used alone)",
      paths: process.env.SHELL_RUNNER_CONFIG ? [process.env.SHELL_RUNNER_CONFIG] : [],
    },
    {
      slot: 2,
      label: `trusted store ${path.join("~", PRIMARY_DIR, ...STORE_ROOT, "<project>", STORE_CONFIG_FILE)}`,
      paths: [storeConfigPath()],
    },
    {
      slot: 3,
      label: `user-global ~/${PRIMARY_DIR}/shell-runner.{yaml,yml,json}`,
      paths: userCandidates(),
    },
  ];
}

/**
 * Whether the path exists and is a regular file (false on any error).
 */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
