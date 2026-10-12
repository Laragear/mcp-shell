// Tool input schemas: the zod validators fastmcp runs before each handler,
// and the marshalling of validated arguments for the command-line builder.

import { z } from "zod";
import { AGENT_FILENAME_RE, resolveNature } from "../config/index.js";
import {
  ACKNOWLEDGE_DESTRUCTIVE_DESCRIPTION,
  OUTPUT_TO_ARG_DESCRIPTION,
  type ToolEntry,
} from "../tools/index.js";

// Agent-decided file output. Present only when the command's config resolves
// to an output_to with allow_agent.
const OUTPUT_TO_ARG = z
  .union([z.boolean(), z.string().regex(AGENT_FILENAME_RE)])
  .describe(OUTPUT_TO_ARG_DESCRIPTION);

// One named argument of a proposed command.
const ARG_SPEC = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

// One check rule: a pattern or a list of patterns.
const CHECK_VALUES = z.union([z.string(), z.array(z.string())]);

/** Input of the save_command built-in: a proposed command plus its group. */
export const saveCommandInput = z.object({
  group: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
  description: z.string().optional(),
  args: z.union([z.boolean(), z.array(ARG_SPEC)]).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  env_inherit: z.boolean().optional(),
  timeout: z.number().optional(),
  cwd: z.string().optional(),
  pipe: z.string().optional(),
  check: z
    .object({
      contains: CHECK_VALUES.optional(),
      not_contains: CHECK_VALUES.optional(),
      regex: CHECK_VALUES.optional(),
      not_regex: CHECK_VALUES.optional(),
    })
    .optional(),
  max_output: z.number().optional(),
  nature: z.enum(["read_only", "normal", "destructive"]).optional(),
  read_only: z.boolean().optional(),
  destructive: z.boolean().optional(),
  output_to: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  group_description: z.string().optional(),
  group_trigger: z.string().optional(),
});

/** Input of the remove_command built-in. */
export const removeCommandInput = z.object({
  group: z.string().min(1),
  label: z.string().min(1),
});

/** The tool's input validator, expressed as a zod object for fastmcp. Arguments
 * the config does not declare are stripped by zod before the handler runs; the
 * advertised JSON schema stays the one built by tools/registry. */
export function zodInput(entry: ToolEntry, outputToAllowed: boolean): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  if (entry.args.mode === "free") {
    shape.args = z
      .array(z.string())
      .describe("Arguments appended to the configured command, each shell-quoted");
  } else if (entry.args.mode === "named") {
    for (const spec of entry.args.specs) {
      const field = z.string().describe(spec.description);
      shape[spec.name] = spec.required ? field : field.optional();
    }
  }
  if (outputToAllowed) {
    shape.output_to = OUTPUT_TO_ARG.optional();
  }
  if (resolveNature(entry.cmd) === "destructive") {
    shape.acknowledge_destructive = z
      .boolean()
      .optional()
      .describe(ACKNOWLEDGE_DESTRUCTIVE_DESCRIPTION);
  }
  return z.object(shape);
}

/** Marshals the zod-parsed arguments into the shape buildCommandline expects
 * for the entry's argument mode. */
export function argValuesFor(entry: ToolEntry, parsed: Record<string, unknown>): unknown {
  if (entry.args.mode === "free") return parsed.args;
  if (entry.args.mode === "named") {
    const { output_to, acknowledge_destructive, ...rest } = parsed;
    return rest;
  }
  return {};
}
