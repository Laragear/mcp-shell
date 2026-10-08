// File output: teeing raw stage output into a file when output_to is
// configured, and validating the agent's per-call opt-in.

import * as fs from "node:fs";
import * as path from "node:path";
import type { NormalizedOutputTo } from "../config/index.js";
import { AGENT_FILENAME_RE, OUTPUT_TO_EXTENSIONS } from "../config/index.js";
import { expandPlaceholders, slug, timestampSlug } from "../support.js";
import type { ToolEntry } from "../tools/index.js";

/**
 * An open-lazily file sink for one run's raw output chunks.
 */
export interface OutputTee {
  readonly path: string | null;
  readonly failure: string | null;
  push(chunk: Buffer, isStderr: boolean): void;
  close(): Promise<void>;
}

/** Tees captured chunks into a file. The file opens lazily on the first
 * captured chunk, with owner-only permissions; nothing is created when the
 * command produces no output. The extension is sniffed from the first chunk
 * (JSON when it starts with { or [) for auto-named files. */
function makeOutputTee(opts: {
  dir: string;
  baseName: string;
  fixedExt: string | null;
  completeName: boolean;
  append: boolean;
  captureStderr: boolean;
}): OutputTee {
  let stream: fs.WriteStream | null = null;
  let filePath: string | null = null;
  let failure: string | null = null;
  return {
    get path() {
      return filePath;
    },
    get failure() {
      return failure;
    },
    push(chunk: Buffer, isStderr: boolean) {
      if (failure) return;
      if (isStderr && !opts.captureStderr) return;
      const s = chunk.toString("utf8");
      const trimmed = s.trimStart();
      const sniff = trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "txt";
      if (!stream) {
        filePath = path.join(
          opts.dir,
          opts.completeName ? opts.baseName : `${opts.baseName}.${opts.fixedExt || sniff}`,
        );
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          stream = fs.createWriteStream(filePath, { flags: opts.append ? "a" : "w", mode: 0o600 });
          stream.on("error", (e) => {
            failure = `${filePath}: ${e.message}`;
          });
        } catch (e: any) {
          failure = `${filePath}: ${e.message}`;
          return;
        }
      }
      stream.write(chunk);
    },
    close() {
      return new Promise<void>((resolve) => (stream ? stream.end(resolve) : resolve()));
    },
  };
}

/** Validates an agent-supplied output_to value (boolean or strict filename)
 * before anything runs. Returns an error string, or null when acceptable. */
export function agentOutputToError(agentOutputTo: unknown): string | null {
  if (agentOutputTo === undefined || agentOutputTo === false || agentOutputTo === true) return null;
  if (typeof agentOutputTo !== "string") {
    return 'output_to must be true or a filename like "report.txt".';
  }
  if (!AGENT_FILENAME_RE.test(agentOutputTo)) {
    return `Invalid output_to filename "${agentOutputTo}". Use letters, digits and a single optional dot, e.g. "report.txt".`;
  }
  const dot = agentOutputTo.lastIndexOf(".");
  const ext = dot >= 0 ? agentOutputTo.slice(dot + 1).toLowerCase() : null;
  if (ext && !OUTPUT_TO_EXTENSIONS.has(ext)) {
    return `output_to extension ".${ext}" is not allowed (use txt, log or json).`;
  }
  return null;
}

/** Builds the file tee for a run from the resolved output_to descriptor and
 * the agent's request. Returns null when nothing should be written. */
export function teeFor(
  entry: ToolEntry,
  outputTo: NormalizedOutputTo,
  agentOutputTo: unknown,
): OutputTee {
  let baseName: string;
  let fixedExt: string | null = null;
  let completeName = false;
  if (!outputTo.allow_agent && outputTo.path) {
    // Always-on: the configured path is used exactly as written.
    baseName = expandPlaceholders(path.basename(outputTo.path), entry.groupKey, entry.cmd.label);
    completeName = true;
  } else if (typeof agentOutputTo === "string") {
    const dot = agentOutputTo.lastIndexOf(".");
    baseName = dot >= 0 ? agentOutputTo.slice(0, dot) : agentOutputTo;
    fixedExt = dot >= 0 ? agentOutputTo.slice(dot + 1).toLowerCase() : null;
  } else {
    baseName = `${slug(entry.cmd.label)}-${timestampSlug()}`;
  }
  return makeOutputTee({
    dir: expandPlaceholders(
      // A normalized output_to always has path or dir; dir is set exactly
      // when path is not.
      outputTo.path ? path.dirname(outputTo.path) : (outputTo.dir as string),
      entry.groupKey,
      entry.cmd.label,
    ),
    baseName,
    fixedExt,
    completeName,
    append: outputTo.append,
    captureStderr: outputTo.stderr,
  });
}
