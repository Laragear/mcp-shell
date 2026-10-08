// Public surface of the runner domain: command execution, output checking
// and session teardown.

export { killRunningChildren } from "./kill.js";
export { matchOutput } from "./check.js";
export { runEntry } from "./run.js";
export type { RunResult } from "./format.js";
