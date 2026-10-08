// Configuration shape types and shared vocabularies. Config files are
// user-authored, so everything parsed from disk is treated as untrusted and
// validated before commands are exposed.

export interface ArgSpec {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
  /** Literal text glued before/after the shell-quoted value. */
  prefix?: string;
  suffix?: string;
}

export interface CheckSpec {
  [rule: string]: unknown;
}

export interface CommandSpec {
  label: string;
  command: string;
  description?: string;
  args?: boolean | ArgSpec[];
  env?: Record<string, unknown>;
  timeout?: number;
  cwd?: string;
  pipe?: string;
  check?: CheckSpec;
  max_output?: number;
  read_only?: boolean;
  destructive?: boolean;
  output_to?: unknown;
}

export interface GroupSpec {
  description?: string;
  trigger?: string;
  env?: Record<string, unknown>;
  timeout?: number;
  cwd?: string;
  output_to?: unknown;
  commands: CommandSpec[];
}

export interface NormalizedOutputTo {
  append: boolean;
  stderr: boolean;
  allow_agent: boolean;
  path: string | null;
  dir: string | null;
}

export interface LoadedConfig {
  path: string | null;
  paths: string[];
  groups: Record<string, GroupSpec>;
  defaults: Record<string, any>;
  issues: string[];
  fatal?: boolean;
  /** $SHELL_RUNNER_CONFIG was used: authoritative, agent proposals refused. */
  explicit?: boolean;
  /** The agent-owned file with human-approved commands, when it exists. */
  agentPath?: string | null;
  /** A project config file exists but is a proposal: never loaded, applied
   * only by the human-run --merge. */
  proposalPath?: string | null;
}

export interface Limits {
  timeoutSec: number;
  maxChars: number;
  outputTo: NormalizedOutputTo | null;
}

export const CHECK_RULES = ["contains", "not_contains", "regex", "not_regex"];
export const RESERVED_KEYS = ["defaults", "version"];

// Agent-supplied filenames: letters and digits with a single optional dot.
export const AGENT_FILENAME_RE = /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)?$/;
export const OUTPUT_TO_EXTENSIONS = new Set(["txt", "log", "json"]);
