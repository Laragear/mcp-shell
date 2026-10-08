// The config_template tool output: renders the current config (or a starter)
// as a fill-in YAML file, with every supported key visible — optional keys
// commented. Block emission lives in yaml.ts.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig } from "../config/index.js";
import { projectDir } from "../config/index.js";
import { emitGroupTemplate } from "./group.js";

export { emitGroupTemplate };

/** The pinned CDN copy of the published package's schema: the committable
 * reference for npx users, who have no node_modules path to point at. */
export const CDN_SCHEMA_URL =
  "https://cdn.jsdelivr.net/npm/@laragear/mcp-shell-runner@1/commands.schema.json";

/**
 * The absolute path of the bundled JSON Schema of the config file, sibling of
 * the compiled output both in the repo and in the published package.
 */
export function configSchemaPath(): string {
  // Two levels up: this file compiles to <root>/mcp/report/template.js.
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "commands.schema.json",
  );
}

/** Whether the path exists and is a regular file. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The `$schema` reference the emitted template carries, most portable first:
 * the project-local install (version-synced with the lockfile), the schema
 * dumped next to the config by the CLI (--schema --save agents), or the
 * pinned CDN copy for pure-npx setups. */
export function schemaRef(): string {
  const installed = path.join(
    projectDir(),
    "node_modules",
    "@laragear",
    "mcp-shell-runner",
    "commands.schema.json",
  );
  if (isFile(installed)) return "./node_modules/@laragear/mcp-shell-runner/commands.schema.json";
  const dumped = path.join(projectDir(), ".agents", "commands.schema.json");
  if (isFile(dumped)) return ".agents/commands.schema.json";
  return CDN_SCHEMA_URL;
}

/** The full template document: schema pointer, copy locations, every group
 * (or the starter group) and the defaults footer. */
export function emitConfigTemplate(cfg: LoadedConfig): string {
  const lines = [
    `# yaml-language-server: $schema=${schemaRef()}`,
    `# shell-runner config template. Save the trusted copy with --template --save agents:`,
    `#   ~/.agents/mcp-shell-runner/<project>/commands.yaml  (trusted store, authoritative)`,
    `#   ~/.agents/shell-runner.yaml                         (user-global; merged per group)`,
    `# or point $SHELL_RUNNER_CONFIG at any path.`,
    `# A <project>/.agents/shell-runner.yaml file is only a proposal: it is never`,
    `# loaded. Review it into the trusted store with --merge.`,
    `# The agent may also propose commands with its save_command tool; you approve`,
    `# each one in a dialog before it lands in ~/.agents/mcp-shell-runner/<project>/agent.yaml.`,
    `# The server re-reads the file on every tool call — edits apply immediately.`,
    ``,
  ];
  const groupKeys = Object.entries(cfg.groups || {}).filter(([, g]) => g && typeof g === "object");
  if (!groupKeys.length) {
    lines.push(...emitGroupTemplate("myproject", {}));
  } else {
    groupKeys.forEach(([key, group], i) => {
      if (i > 0) lines.push(``);
      lines.push(...emitGroupTemplate(key, group));
    });
  }
  lines.push(
    ``,
    `# Optional config-wide fallbacks:`,
    `# defaults:`,
    `#   timeout: 120      # seconds`,
    `#   max_output: 20000  # chars`,
  );
  return lines.join("\n");
}
