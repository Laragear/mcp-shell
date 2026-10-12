// Process spawning: one command line through /bin/sh, with bounded capture,
// timeout and cancellation. Killing lives in kill.ts.

import { spawn } from "node:child_process";
import type { NormalizedTruncate } from "../config/index.js";
import { makeCollector } from "./capture.js";
import { killTree, trackRunningChild } from "./kill.js";

export interface StageResult {
  spawnError?: Error;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stage?: string;
  stdout: string;
  stderr: string;
  rawChunks?: Buffer[];
}

export interface StageOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxChars: number;
  truncate?: NormalizedTruncate;
  signal?: AbortSignal;
  stage?: string;
  stdinChunks?: Buffer[];
  onChunk?: (chunk: Buffer, isStderr: boolean) => void;
}

/**
 * Starts the child in its own process group and wires its streams to the
 * collectors and the raw-output tee.
 */
function startChild(command: string, opts: StageOptions, onChunk: StageOptions["onChunk"]) {
  // No configured truncate shape: the v1.0 default keeps the first maxChars
  // characters.
  const plan = opts.truncate ?? {
    kind: "default" as const,
    mode: "start" as const,
    limit: opts.maxChars,
  };
  const out = makeCollector(plan);
  const err = makeCollector(plan);
  const child = spawn("/bin/sh", ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (c: Buffer) => {
    out.push(c);
    if (onChunk) onChunk(c, false);
  });
  child.stderr?.on("data", (c: Buffer) => {
    err.push(c);
    if (onChunk) onChunk(c, true);
  });
  child.stdin?.on("error", () => {});
  if (opts.stdinChunks?.length) {
    for (const c of opts.stdinChunks) child.stdin?.write(c);
  }
  child.stdin?.end();
  return { child, out, err };
}

/** Runs one command line through /bin/sh in its own process group (no
 * orphaned grandchildren). Never throws; resolves with the stage result. */
export function spawnStage(command: string, opts: StageOptions): Promise<StageResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const stage = opts.stage || "";
    const { child, out, err } = startChild(command, opts, opts.onChunk);
    const settle = (result: StageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, false);
    }, opts.timeoutMs);
    // The MCP layer aborts the signal when the client cancels the request:
    // graceful SIGTERM to the group, then SIGKILL after a short grace.
    const onAbort = () => {
      cancelled = true;
      clearTimeout(timer);
      killTree(child, true);
      setTimeout(() => {
        if (!settled) killTree(child, false);
      }, 250);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) =>
      settle({ spawnError: e, stage, timedOut, cancelled, stdout: out.text(), stderr: err.text() }),
    );
    child.on("close", (code, signal) =>
      settle({
        exitCode: code,
        signal,
        timedOut,
        cancelled,
        stage,
        stdout: out.text(),
        stderr: err.text(),
        rawChunks: out.chunks(),
      }),
    );
    trackRunningChild(child);
  });
}
