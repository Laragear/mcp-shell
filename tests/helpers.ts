// Shared helpers: temp configs and env-scoped loading.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type LoadedConfig } from "../src/config/index.js";
import { flattenTools, type ToolEntry, type ToolSchema } from "../src/tools/index.js";

export interface DeclaredTool {
  entry: ToolEntry;
  schema: ToolSchema;
}

export function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeConfig(dir: string, text: string): string {
  const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, text);
  return p;
}

/** Loads config text through the real discovery path ($SHELL_RUNNER_CONFIG),
 * restoring the environment afterwards. */
export function loadConfigFor(text: string): LoadedConfig {
  const tmp = makeTmp("sr-cfg-");
  const prev = process.env.SHELL_RUNNER_CONFIG;
  process.env.SHELL_RUNNER_CONFIG = writeConfig(tmp, text);
  try {
    return loadConfig();
  } finally {
    if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
    else process.env.SHELL_RUNNER_CONFIG = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Declared-command tools (built-ins filtered out) for a config text. */
export function toolsFor(text: string): { tools: DeclaredTool[]; cfg: LoadedConfig } {
  const cfg = loadConfigFor(text);
  return {
    tools: flattenTools(cfg.groups, cfg.defaults).filter(
      (t): t is DeclaredTool => !("builtin" in t.entry),
    ),
    cfg,
  };
}

/** Runs fn with env overrides applied, restoring the environment afterwards. */
export function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    process.env = prev;
  }
}
