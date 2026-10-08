#!/usr/bin/env node

// The binary entry point: dispatches the CLI subcommands, otherwise serves
// stdio. Kept apart from server.ts so the ESM entry never dynamically imports
// stdio (which imports server), which would deadlock the module evaluation.

import { runCli } from "./cli.js";
import { serveStdio } from "./stdio.js";
import { ShellRunnerServer } from "./server/index.js";

const cli = runCli(process.argv.slice(2));

if (cli !== -1) {
  process.exit(cli);
}

serveStdio(new ShellRunnerServer()).catch((e: any) => {
  process.stderr.write(`shell-runner: ${e.stack || e.message}\n`);
  process.exit(1);
});
