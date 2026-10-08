// Run orchestration: executes the prepared command (and its optional parse
// stage) and enforces the output contract (exit code, signal death, timeout,
// cancellation all reported as they happened).

import type { ToolEntry } from "../tools/index.js";
import { CANCELLED_RESULT, formatRunResult, reportWith, type RunResult } from "./format.js";
import { prepareRun } from "./prepare.js";
import { spawnStage } from "./process.js";

/** Runs the command (and its optional parse stage) enforcing the output
 * contract. When output_to resolves to an enabled spec, the raw stage-1
 * output is teed into a file while the result keeps its usual shape. */
export async function runEntry(
  entry: ToolEntry,
  argValues: unknown,
  defaults: Record<string, any>,
  signal?: AbortSignal,
  agentOutputTo?: unknown,
): Promise<RunResult> {
  const prepared = prepareRun(entry, argValues, defaults, signal, agentOutputTo);
  if ("error" in prepared) return prepared.error;
  const { command, opts, timeoutSec, parse, tee } = prepared;
  const { cmd } = entry;

  const r1 = await spawnStage(command, opts);
  if (tee) await tee.close();
  if (tee?.failure) {
    return { isError: true, text: `Could not write output file — ${tee.failure}` };
  }
  const outputFile = tee?.path ?? null;
  if (r1.spawnError) return { isError: true, text: `Failed to start: ${r1.spawnError.message}` };
  if (r1.cancelled || signal?.aborted) return CANCELLED_RESULT;
  const report = (over: object) =>
    formatRunResult({
      timedOut: false,
      timeoutSec,
      exitCode: r1.exitCode ?? null,
      stdout: r1.stdout,
      stderr: r1.stderr,
      cmd,
      outputFile,
      ...over,
    });

  // A timeout kill and an external signal both arrive as a signal; the
  // timedOut flag (set by our own timer) decides which report is true.
  if (r1.timedOut) return report({ timedOut: true, exitCode: null });
  if (r1.signal) {
    return {
      isError: true,
      text: `killed by signal ${r1.signal}\n${reportWith(outputFile, null, r1.stdout, r1.stderr)}`.trim(),
    };
  }
  if (!parse) return report({});

  const r2 = await spawnStage(parse, { ...opts, stage: "parse", stdinChunks: r1.rawChunks });
  // The first command decides the exit code; the parse stage only shapes
  // what the agent reads.
  const parseReport = (over: object) =>
    report({
      exitCode: r1.exitCode ?? null,
      stdout: r2.stdout,
      stderr: [r1.stderr, r2.stderr].filter(Boolean).join("\n"),
      ...over,
    });
  if (r2.spawnError) {
    return report({
      stdout: r1.stdout,
      stderr: [r1.stderr, `parse failed to start: ${r2.spawnError.message}`]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (r2.cancelled || signal?.aborted) return CANCELLED_RESULT;
  if (r2.timedOut) return parseReport({ timedOut: true, stageLabel: "parse", exitCode: null });
  return parseReport({});
}
