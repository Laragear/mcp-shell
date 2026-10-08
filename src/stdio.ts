// Process teardown: fastmcp owns the stdio transport itself; this module only
// takes running commands down with the process instead of leaving orphaned
// test suites.

import { killRunningChildren } from "./runner/index.js";
import { SERVER_VERSION, type ShellRunnerServer } from "./server/index.js";

/**
 * Serves the MCP server over stdio until the client disconnects.
 */
export async function serveStdio(runner: ShellRunnerServer): Promise<void> {
  await runner.serve();

  // When the client disappears (stdin closes) or the process is signaled,
  // take running commands with it instead of leaving orphaned test suites.
  process.stdin.on("close", () => killRunningChildren());

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      killRunningChildren();

      process.exit(1);
    });
  }

  process.on("unhandledRejection", (e: any) =>
    process.stderr.write(`shell-runner: ${e?.stack ? e.stack : e}\n`),
  );

  if (process.platform === "win32") {
    process.stderr.write(
      "shell-runner: warning — commands are quoted for POSIX shells and will run under cmd.exe; use WSL instead\n",
    );
  }
  process.stderr.write(`shell-runner v${SERVER_VERSION} ready (stdin JSON-RPC)\n`);
}
