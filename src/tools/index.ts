// Public surface of the tool domain: generation, command-line building and
// the shared shapes.

export type { ArgsMode, ToolEntry, ToolList, ToolSchema } from "./types.js";
export { argMode, buildCommandline, previewCommandline } from "./commandline.js";
export { toolDescription, toolInputSchema } from "./schema.js";
export {
  ACKNOWLEDGE_DESTRUCTIVE_DESCRIPTION,
  BUILTIN_TOOLS,
  flattenTools,
  OUTPUT_TO_ARG_DESCRIPTION,
} from "./registry.js";
