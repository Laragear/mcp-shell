// The agent-facing result of a run: shaping output, check verdicts and the
// circumstances of death (timeout, signal) into one text payload.

import type { CommandSpec } from "../config/index.js";
import { matchOutput } from "./check.js";

export interface RunResult {
  isError: boolean;
  text: string;
  cancelled?: boolean;
}

export const CANCELLED_RESULT: RunResult = {
  isError: true,
  cancelled: true,
  text: "Cancelled by client.",
};

/** The part of a finished stage every report shares: output file line plus
 * the stdout/stderr body. */
export function reportWith(
  outputFile: string | null,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  return `${outputFile ? `output file: ${outputFile}\n` : ""}exit code: ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
}

/** Formats a finished stage into the agent-facing result, applying the check
 * rules to the command's own output. The parse stage never changes the exit
 * code and its output is not checked. */
export function formatRunResult(r: {
  timedOut: boolean;
  timeoutSec: number;
  stageLabel?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cmd: CommandSpec;
  outputFile?: string | null;
}): RunResult {
  let isError = r.timedOut || (r.exitCode !== null && r.exitCode !== 0);
  let text = r.timedOut
    ? `Timed out after ${r.timeoutSec}s${r.stageLabel ? ` (${r.stageLabel} stage)` : ""} and was killed.\n`
    : "";
  if (r.outputFile) text += `output file: ${r.outputFile}\n`;
  text += `exit code: ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  if (r.cmd.check && typeof r.cmd.check === "object" && !r.timedOut) {
    const verdict = matchOutput(`${r.stdout}\n${r.stderr}`, r.cmd.check);
    if (!verdict.ok) {
      isError = true;
      text = `CHECK FAILED: output ${verdict.reasons.join("; ")}.\n${text}`;
    } else {
      text = `CHECK PASSED.\n${text}`;
    }
  }
  return { isError, text: text.trim() };
}
