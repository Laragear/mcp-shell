// Developer CLI, no MCP session needed:
//   server --validate [config-path]   doctor report; exit 0 valid, 1 issues
//   server --merge                    review a project proposal into the store
//   server --template [config-path] [--save agents|user] [--force]
//   server --schema [--save agents] [--force]

import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentsDir,
  emitAgentGroups,
  loadConfig,
  parseConfigFile,
  projectProposalPath,
  storeConfigPath,
  type LoadedConfig,
  validateConfig,
  writeAgentGroups,
} from "./config/index.js";
import { configSchemaPath, doctorReport, emitConfigTemplate } from "./report/index.js";

/**
 * The file `--save <key>` writes to, or null for an unknown key. "agents" is
 * the trusted store of this project; "user" is the user-global companion.
 */
export function saveTarget(key: string): string | null {
  if (key === "agents") return storeConfigPath();
  if (key === "user") return path.join(agentsDir("user"), "shell-runner.yaml");
  return null;
}

/**
 * The file `--schema --save agents` writes: the schema next to the project
 * config, where humans draft proposals and editors need the type hints.
 */
export function schemaSaveTarget(): string {
  return path.join(agentsDir("project"), "commands.schema.json");
}

/** Prints the doctor report for the effective config; exit 1 on issues.
 * SHELL_RUNNER_VALIDATE=1 keeps working as an alias for --validate. */
function runValidate(argv: string[]): number {
  if (argv[0] === "--validate" && argv[1]) process.env.SHELL_RUNNER_CONFIG = argv[1];
  const cfg: LoadedConfig = loadConfig();
  console.log(doctorReport(cfg));
  return cfg.issues.length ? 1 : 0;
}

/**
 * Parses the flags after --template / --schema.
 */
function parseFlags(argv: string[]): {
  cfgPath: string | null;
  save: string | null;
  force: boolean;
} {
  let cfgPath: string | null = null;
  let save: string | null = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--save") save = argv[++i];
    else if (argv[i] === "--force") force = true;
    else if (cfgPath === null) cfgPath = argv[i];
  }
  return { cfgPath, save, force };
}

/** Writes text to its target, refusing to overwrite without --force. False on
 * failure (the error is already printed). */
function saveFile(what: string, text: string, target: string, force: boolean): boolean {
  if (fs.existsSync(target) && !force) {
    console.error(`${target} already exists — pass --force to replace it`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${text}\n`);
    console.log(`${what} written to ${target}`);
  } catch (e: any) {
    console.error(`Save failed: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Renders the config template to stdout, or saves it with --save.
 */
function runTemplate(argv: string[]): number {
  const { cfgPath, save, force } = parseFlags(argv);
  if (cfgPath) process.env.SHELL_RUNNER_CONFIG = cfgPath;
  const text = emitConfigTemplate(loadConfig());
  if (!save) console.log(text);
  else {
    const target = saveTarget(save);
    if (!target) {
      console.error(`Unknown save target "${save}" (use "agents" or "user")`);
      return 1;
    }
    if (!saveFile("Template", text, target, force)) return 1;
  }
  return 0;
}

/**
 * Prints the bundled JSON Schema to stdout, or saves it next to the project
 * config with --save agents, so the editor $schema line can point at a
 * committed file in pure-npx setups.
 */
function runSchema(argv: string[]): number {
  const { save, force } = parseFlags(argv);
  const text = fs.readFileSync(configSchemaPath(), "utf8").trimEnd();
  if (!save) console.log(text);
  else {
    if (save !== "agents") {
      console.error(`Unknown save target "${save}" (use "agents")`);
      return 1;
    }
    if (!saveFile("Schema", text, schemaSaveTarget(), force)) return 1;
  }
  return 0;
}

/**
 * The terminal I/O of the --merge confirmation. Injectable so tests can
 * answer the prompt without a real stdin.
 */
export const mergeIo: { prompt: (text: string) => void; readLine: () => string } = {
  prompt: (text) => process.stdout.write(text),
  readLine: () => {
    const buf = Buffer.alloc(1024);
    const read = fs.readSync(0, buf, 0, 1024, null);
    return buf.subarray(0, read).toString("utf8");
  },
};

/** Merges the project proposal into the trusted store after an explicit
 * human confirmation. Nothing is written without a "y" answer. */
function runMerge(): number {
  if (process.env.SHELL_RUNNER_CONFIG) {
    console.error("$SHELL_RUNNER_CONFIG is set and used alone; there is nothing to merge.");
    return 1;
  }
  const proposal = projectProposalPath();
  if (!proposal) {
    console.error(
      `No project config proposal found (looked for <project>/.agents/shell-runner.{yaml,yml,json}).`,
    );
    return 1;
  }
  let proposalGroups: Record<string, any>;
  try {
    const parsed = parseConfigFile(proposal);
    proposalGroups = Object.fromEntries(
      Object.entries(parsed || {}).filter(([k]) => !["defaults", "version"].includes(k)),
    );
  } catch (e: any) {
    console.error(`${proposal} could not be parsed: ${e.message}`);
    return 1;
  }
  const store = storeConfigPath();
  let storeGroups: Record<string, any> = {};
  let storeDefaults: Record<string, any> = {};
  try {
    // Reserved keys of the store (its defaults) survive the merge untouched;
    // the proposal's reserved keys are ignored: it is an unreviewed draft.
    if (fs.existsSync(store)) {
      const parsed = parseConfigFile(store) || {};
      storeDefaults = parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {};
      storeGroups = Object.fromEntries(
        Object.entries(parsed).filter(([k]) => !["defaults", "version"].includes(k)),
      );
    }
  } catch (e: any) {
    console.error(`${store} could not be parsed: ${e.message}`);
    return 1;
  }
  const fresh = Object.keys(proposalGroups).filter((k) => !(k in storeGroups));
  const clashing = Object.keys(proposalGroups).filter((k) => k in storeGroups);
  console.log(`Proposal ${proposal}:\n`);
  console.log(emitAgentGroups(proposalGroups).trimEnd());
  console.log(`\nNew groups: ${fresh.length ? fresh.join(", ") : "(none)"}`);
  console.log(
    `Conflicting groups (the store version is OVERWRITTEN): ${clashing.length ? clashing.join(", ") : "(none)"}`,
  );
  mergeIo.prompt(`\nMerge into ${store}? [y/N] `);
  if (!/^[\r\n]?y/i.test(mergeIo.readLine())) {
    console.log("Aborted; nothing was written.");
    return 1;
  }
  const merged = { ...storeGroups, ...proposalGroups };
  const issues = validateConfig(merged).issues;
  if (issues.length) {
    console.error(`The merge would produce an invalid config, nothing was written:`);
    for (const issue of issues) console.error(`  ! ${issue}`);
    return 1;
  }
  writeAgentGroups(store, merged, storeDefaults);
  console.log(`Merged into ${store}.`);
  return 0;
}

/** Dispatches the CLI subcommand; -1 when argv is not a CLI invocation and
 * the caller should serve stdio instead. */
export function runCli(argv: string[]): number {
  if (process.env.SHELL_RUNNER_VALIDATE === "1" || argv[0] === "--validate") {
    return runValidate(argv);
  }
  if (argv[0] === "--merge") return runMerge();
  if (argv[0] === "--template") return runTemplate(argv.slice(1));
  if (argv[0] === "--schema") return runSchema(argv.slice(1));
  return -1;
}
