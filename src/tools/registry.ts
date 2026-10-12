// Tool generation: every "commands" entry in every group becomes one MCP
// tool named `<group>__<slug>`; on collision a numeric suffix (_2, _3, …) is
// appended in declaration order — deterministic for a given config, but
// rename to avoid collisions.

import type { GroupSpec, NormalizedOutputTo } from "../config/index.js";
import { resolveOutputTo } from "../config/index.js";
import { slug } from "../support.js";
import { argMode } from "./commandline.js";
import { toolDescription, toolInputSchema } from "./schema.js";
import type { ToolList, ToolSchema } from "./types.js";

export { OUTPUT_TO_ARG_DESCRIPTION } from "./schema.js";

/**
 * The first unused `<group>__<slug>` name, suffixing _2, _3, … on collision.
 */
function uniqueToolName(groupKey: string, cmdName: string, used: Set<string>): string {
  const base = `${slug(groupKey)}__${slug(cmdName)}`;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

// The command keys the agent may propose through save_command; everything
// else in the schema mirrors what a human writes in the config file.
const SAVE_COMMAND_PROPERTIES: Record<string, any> = {
  group: {
    type: "string",
    description:
      "Group to place the command in. Created when new; refused when a human config already declares this group.",
  },
  label: {
    type: "string",
    description: "Short human-readable label; slugged into the tool name",
  },
  command: { type: "string", description: "The exact command line to run through the shell" },
  description: {
    type: "string",
    description: "What the command does; refines the tool description",
  },
  args: {
    oneOf: [
      { type: "boolean" },
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            required: { type: "boolean" },
            default: { type: "string" },
            prefix: { type: "string", description: "Literal text glued before the quoted value" },
            suffix: { type: "string", description: "Literal text glued after the quoted value" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ],
    description: "false (default), true for free-form arguments, or a named-argument list",
  },
  env: { type: "object", description: "Extra environment variables, NAME: value" },
  env_inherit: {
    type: "boolean",
    description:
      "false runs the command only with its declared env (PATH and HOME survive); default inherits the parent environment",
  },
  timeout: { type: "number", description: "Seconds before the command is killed" },
  cwd: { type: "string", description: "Working directory" },
  pipe: {
    type: "string",
    description: "Command piped after stdout; the exit code stays the command's",
  },
  check: {
    type: "object",
    properties: {
      contains: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      not_contains: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      regex: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      not_regex: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    },
    additionalProperties: false,
    description: "Success rules on the output",
  },
  max_output: { type: "number", description: "Output truncation limit in chars" },
  read_only: { type: "boolean", description: "Hint: the command does not modify its environment" },
  destructive: { type: "boolean", description: "Hint: the command may delete or overwrite" },
  output_to: {
    oneOf: [{ type: "string" }, { type: "object" }],
    description: "Opt-in raw output to a file, as in the config file",
  },
  group_description: { type: "string", description: "Group description, when creating the group" },
  group_trigger: { type: "string", description: "Group trigger, when creating the group" },
};

const SAVE_COMMAND_SCHEMA = {
  type: "object",
  properties: SAVE_COMMAND_PROPERTIES,
  required: ["group", "label", "command"],
  additionalProperties: false,
};

const REMOVE_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    group: { type: "string", description: "Group of the command to remove" },
    label: { type: "string", description: "Label of the command to remove" },
  },
  required: ["group", "label"],
  additionalProperties: false,
};

export const BUILTIN_TOOLS: Array<{ schema: ToolSchema; builtin: string }> = [
  {
    schema: {
      name: "list_commands",
      title: "List exposed commands",
      description:
        "List every command this server exposes, from which config file, with the exact final " +
        "command line of each tool, effective timeout/output limits, and any config warnings.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    builtin: "list_commands",
  },
  {
    schema: {
      name: "config_template",
      title: "Generate config template",
      description:
        "Output a ready-to-fill YAML config template of the current configuration, with every " +
        "supported key visible (optional ones commented out), or a starter template when no " +
        "config is loaded. The reference for humans and agents alike. Read-only: to save a " +
        "template, use the CLI (--template [--save agents|user] [--force]).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    builtin: "template",
  },
  {
    schema: {
      name: "config_schema",
      title: "Config JSON schema",
      description:
        "The bundled JSON Schema of the config file (commands.schema.json): every group and " +
        "command key with its type and description. Feed it to whoever writes the config by " +
        "hand, human or agent, so no key is guessed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    builtin: "schema",
  },
  {
    schema: {
      name: "save_command",
      title: "Propose a command for the human to approve",
      description:
        "Propose adding or updating one shell command. The human approves it in a dialog before " +
        "anything is written to the agent config file; the new tool is available immediately " +
        "after approval. Refused when the group already exists in a human config file.",
      inputSchema: SAVE_COMMAND_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    builtin: "save_command",
  },
  {
    schema: {
      name: "remove_command",
      title: "Propose removing a command",
      description:
        "Propose removing one command previously approved through save_command. The human " +
        "approves it in a dialog before anything is written. Commands from human config files " +
        "cannot be removed here.",
      inputSchema: REMOVE_COMMAND_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    builtin: "remove_command",
  },
];

/** The tool entry for one command, or null when the declaration is invalid
 * (already reported as a config issue). */
function commandTool(
  groupKey: string,
  group: GroupSpec,
  cmd: any,
  used: Set<string>,
  defaults: Record<string, any>,
): ToolList[number] | null {
  if (!cmd || typeof cmd !== "object" || typeof cmd.command !== "string" || !cmd.command.trim())
    return null;
  if (typeof cmd.label !== "string" || !cmd.label.trim()) return null;
  const name = uniqueToolName(groupKey, cmd.label, used);
  const args = argMode(cmd);
  const outputTo = resolveOutputTo(cmd, group, defaults) as NormalizedOutputTo | null;
  const readOnly = cmd.read_only === true;
  const schema: ToolSchema = {
    name,
    title: cmd.label,
    description: toolDescription(groupKey, group, cmd, args, outputTo),
    inputSchema: toolInputSchema(args, outputTo?.allow_agent === true),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: cmd.destructive === true ? true : !readOnly,
    },
  };
  return { entry: { groupKey, group, cmd, toolName: name, args }, schema };
}

/** One Tool per declared command, plus the built-ins. Invalid commands are
 * skipped; they were already reported as config issues. */
export function flattenTools(
  groups: Record<string, GroupSpec>,
  defaults: Record<string, any> = {},
): ToolList {
  const tools: ToolList = [];
  const used = new Set<string>();
  for (const [groupKey, group] of Object.entries(groups || {})) {
    if (!group || typeof group !== "object" || !Array.isArray((group as GroupSpec).commands))
      continue;
    for (const cmd of (group as GroupSpec).commands) {
      const tool = commandTool(groupKey, group as GroupSpec, cmd, used, defaults);
      if (tool) tools.push(tool);
    }
  }
  return tools.concat(BUILTIN_TOOLS.map((b) => ({ entry: b, schema: b.schema })));
}
