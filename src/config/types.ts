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

/** The output umbrella: canonical home of file output (`to`, same shape as
 * output_to), the pipe stage and the truncation shape. Coalesced into the
 * top-level keys at load. */
export interface OutputSpec {
  [key: string]: unknown;
  to?: unknown;
  pipe?: unknown;
  truncate?: number | TruncateSpec;
}

/** How output is cut down: keep `length` characters or `bytes` bytes from
 * the start or the end of the stream. */
export interface TruncateSpec {
  [key: string]: unknown;
  mode?: unknown;
  length?: unknown;
  bytes?: unknown;
}

/** The effective truncation shape of a run. "default" is the v1.0 behavior:
 * keep the first `limit` characters. */
export interface NormalizedTruncate {
  kind: "default" | "chars" | "bytes";
  mode: "start" | "end";
  limit: number;
}

export interface CommandSpec {
  label: string;
  command: string;
  description?: string;
  args?: boolean | ArgSpec[];
  env?: Record<string, unknown>;
  env_inherit?: boolean;
  timeout?: number;
  cwd?: string;
  pipe?: string;
  check?: CheckSpec;
  max_output?: number;
  read_only?: boolean;
  destructive?: boolean;
  output_to?: unknown;
  output?: OutputSpec;
}

export interface GroupSpec {
  description?: string;
  trigger?: string;
  env?: Record<string, unknown>;
  env_inherit?: boolean;
  timeout?: number;
  cwd?: string;
  output_to?: unknown;
  output?: OutputSpec;
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
  envInherit: boolean;
  truncate: NormalizedTruncate;
  outputTo: NormalizedOutputTo | null;
}

export const CHECK_RULES = ["contains", "not_contains", "regex", "not_regex"];
export const RESERVED_KEYS = ["defaults", "version"];

// Agent-supplied filenames: letters and digits with a single optional dot.
export const AGENT_FILENAME_RE = /^[A-Za-z0-9]+(\.[A-Za-z0-9]+)?$/;
export const OUTPUT_TO_EXTENSIONS = new Set(["txt", "log", "json"]);
