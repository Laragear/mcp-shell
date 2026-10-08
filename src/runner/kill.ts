// Session teardown for spawned commands: every child runs in its own process
// group so a kill reaches pipelines and grandchildren.

import type { ChildProcess } from "node:child_process";

// In-flight child processes, so a killed MCP session takes its commands down.
const runningChildren = new Set<ChildProcess>();

/** Kills a child's whole process group (pipelines and grandchildren die too).
 * Graceful sends SIGTERM first; hard goes straight to SIGKILL. */
export function killTree(child: ChildProcess, graceful: boolean): void {
  if (!child.pid) return;
  const sig = graceful ? "SIGTERM" : "SIGKILL";
  if (process.platform === "win32") {
    try {
      child.kill(sig as any);
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig as any);
    } catch {}
  }
}

/** Takes every running command down with the session and cancels pending
 * calls. Registered against stdin close and termination signals. */
export function killRunningChildren(): void {
  for (const child of runningChildren) {
    killTree(child, false);
  }
}

/**
 * Tracks a child so session teardown can find it; untracked on exit.
 */
export function trackRunningChild(child: ChildProcess): void {
  runningChildren.add(child);
  child.on("close", () => runningChildren.delete(child));
}
