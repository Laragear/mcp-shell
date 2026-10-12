// The MCP-visible schema of one generated tool: name-independent description
// and JSON input schema, shared by the registry and the zod validators.

import type { CommandSpec, GroupSpec, NormalizedOutputTo } from "../config/index.js";
import { AGENT_FILENAME_RE } from "../config/index.js";
import { commandPlaceholders } from "../support.js";
import type { ArgsMode } from "./types.js";

/** Description of the agent-decided output_to tool argument, shared by the
 * JSON schema here and the zod schema in the server. */
export const OUTPUT_TO_ARG_DESCRIPTION =
  "Write this run's raw output under the configured directory. true picks an auto-named file " +
  "(<command>-<timestamp>.json|.txt); or pass a strict filename like report.txt " +
  "(letters, digits, one optional dot; txt, log or json).";

// Tool argument that lets the agent opt into file output at call time.
const OUTPUT_TO_ARG_SCHEMA = {
  description: OUTPUT_TO_ARG_DESCRIPTION,
  oneOf: [{ type: "boolean" }, { type: "string", pattern: AGENT_FILENAME_RE.source }],
};

/** The tool description: what it runs, how arguments are passed, and whether
 * the agent may opt into file output. */
export function toolDescription(
  groupKey: string,
  group: GroupSpec,
  cmd: CommandSpec,
  args: ArgsMode,
  outputTo: NormalizedOutputTo | null,
): string {
  const parts = [`${groupKey} / ${cmd.label}`, cmd.description || group.description || ""].filter(
    Boolean,
  );
  if (group.trigger) parts.push(`Trigger when: ${group.trigger}`);
  if (args.mode === "free") {
    parts.push(
      "Accepts free-form arguments (passed as a list, shell-quoted, appended to the command).",
    );
  } else if (args.mode === "named") {
    const ph = commandPlaceholders(cmd.command);
    const how = ph.length
      ? `fills the {${ph.join("}, {")}} placeholder${ph.length > 1 ? "s" : ""} in the command line`
      : "appended to the command in declared order";
    parts.push(
      `Accepts named arguments: ${args.specs.map((s) => s.name + (s.required ? "*" : "")).join(", ")} (* required); values are ${how}.`,
    );
  } else {
    parts.push("Runs exactly as configured; no arguments accepted.");
  }
  if (outputTo?.allow_agent) {
    parts.push(
      "You may pass output_to (true, or a filename like report.txt) to save this run's raw output under the configured directory.",
    );
  }
  return parts.join(" — ");
}

/** The JSON input schema for one args mode, plus the conditional output_to
 * argument when the agent may opt into file output. */
export function toolInputSchema(args: ArgsMode, outputToAllowed: boolean): Record<string, any> {
  const schema: Record<string, any> =
    args.mode === "free"
      ? {
          type: "object",
          properties: {
            args: {
              type: "array",
              items: { type: "string" },
              description: "Arguments appended to the configured command, each shell-quoted",
            },
          },
          additionalProperties: false,
        }
      : args.mode === "named"
        ? {
            type: "object",
            properties: Object.fromEntries(
              args.specs.map((s) => [s.name, { type: "string", description: s.description }]),
            ),
            required: args.specs.filter((s) => s.required).map((s) => s.name),
            additionalProperties: false,
          }
        : { type: "object", properties: {}, additionalProperties: false };
  if (outputToAllowed) {
    schema.properties.output_to = OUTPUT_TO_ARG_SCHEMA;
  }
  return schema;
}
