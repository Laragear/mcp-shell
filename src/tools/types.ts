// Shapes shared by tool generation, command-line building and the server.

import type { CommandSpec, GroupSpec } from "../config/index.js";

export interface ArgsMode {
  mode: "none" | "free" | "named";
  specs: Array<{
    name: string;
    description: string;
    required: boolean;
    default: string | undefined;
    prefix: string | undefined;
    suffix: string | undefined;
  }>;
}

export interface ToolEntry {
  groupKey: string;
  group: GroupSpec;
  cmd: CommandSpec;
  toolName: string;
  args: ArgsMode;
}

export interface ToolSchema {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

export type ToolList = Array<{ entry: ToolEntry | { builtin: string }; schema: ToolSchema }>;
