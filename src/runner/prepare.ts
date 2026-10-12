// Run preparation: everything a run needs before spawning, decided once so
// the orchestration layer only executes.

import type { CommandSpec, GroupSpec } from "../config/index.js";
import { effectiveLimits } from "../config/index.js";
import { buildCommandline, type ToolEntry } from "../tools/index.js";
import { agentOutputToError, teeFor, type OutputTee } from "./output-file.js";
import type { RunResult } from "./format.js";
import type { StageOptions } from "./process.js";

/** Everything a run needs before spawning: the command line, effective
 * limits, environment, working directory and the file tee, or a finished
 * error result when preparation rejects the call. */
export type PreparedRun =
  | { error: RunResult }
  | {
      command: string;
      opts: StageOptions;
      timeoutSec: number;
      parse: string | null;
      tee: OutputTee | null;
    };

/** Validates arguments, resolves limits/env/cwd and decides whether raw
 * output is teed into a file. */
export function prepareRun(
  entry: ToolEntry,
  argValues: unknown,
  defaults: Record<string, any>,
  signal: AbortSignal | undefined,
  agentOutputTo: unknown,
): PreparedRun {
  const { group, cmd } = entry;
  const command = buildCommandline(entry, argValues);
  if (typeof command !== "string") {
    return { error: { isError: true, text: command.error } };
  }
  const { timeoutSec, maxChars, envInherit, outputTo } = effectiveLimits(
    cmd as CommandSpec,
    group as GroupSpec,
    defaults,
  );
  const invalid = agentOutputToError(agentOutputTo);
  if (invalid) return { error: { isError: true, text: invalid } };
  const notAllowed = agentNotAllowed(agentOutputTo, outputTo);
  if (notAllowed) return { error: { isError: true, text: notAllowed } };

  const agentWants = agentOutputTo !== undefined && agentOutputTo !== false;
  const tee =
    outputTo && (!outputTo.allow_agent || agentWants)
      ? teeFor(entry, outputTo, agentOutputTo)
      : null;
  return {
    command,
    timeoutSec,
    parse: parseStage(cmd),
    tee,
    opts: {
      cwd: cmd.cwd || group.cwd || process.env.SHELL_RUNNER_CWD || process.cwd(),
      env: runEnv(group as GroupSpec, cmd as CommandSpec, envInherit),
      timeoutMs: timeoutSec * 1000,
      maxChars,
      signal,
      onChunk: tee ? (c, isErr) => tee.push(c, isErr) : undefined,
    },
  };
}

/** The rejection message when the agent asks for file output the config does
 * not allow, or empty when the call may proceed. */
function agentNotAllowed(
  agentOutputTo: unknown,
  outputTo: { allow_agent: boolean } | null,
): string {
  // A request on a command without file output enabled is rejected, even
  // when nothing is configured at any level.
  const agentWants = agentOutputTo !== undefined && agentOutputTo !== false;
  if (agentWants && !outputTo?.allow_agent) {
    return '"output_to" is not enabled for this command; the config must set allow_agent: true.';
  }
  return "";
}

/** The environment for the run: process env plus group then command env. With
 * inheritance off, only the declared env is passed, plus PATH and HOME from
 * the parent so /bin/sh and cwd resolution keep working. */
function runEnv(group: GroupSpec, cmd: CommandSpec, inherit: boolean): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(group.env || {})) env[k] = String(v);
  for (const [k, v] of Object.entries(cmd.env || {})) env[k] = String(v);
  if (!inherit) {
    const minimal: Record<string, string> = {};
    for (const key of ["PATH", "HOME"]) {
      const v = process.env[key];
      if (v !== undefined) minimal[key] = v;
    }
    return { ...minimal, ...env };
  }
  return { ...process.env, ...env };
}

/** The optional parse stage command, or null when absent/blank. */
function parseStage(cmd: CommandSpec): string | null {
  return typeof cmd.pipe === "string" && cmd.pipe.trim() ? cmd.pipe : null;
}
