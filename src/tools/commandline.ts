// Command-line building: the static preview for docs and list_commands, and
// the final command line for a call. Placeholder values are filled in place
// (shell-quoted); leftover named arguments append in declared order.

import type { ArgSpec, CommandSpec } from "../config/index.js";
import { commandPlaceholders, shellQuote } from "../support.js";
import type { ArgsMode, ToolEntry } from "./types.js";

/** Normalizes the `args` key of a command into an argument-mode descriptor:
 * none (absent/false), free (true) or named (declared list). The description
 * of a decorated argument mentions its literal prefix/suffix, so agents see
 * how the value is passed. */
export function argMode(cmd: CommandSpec): ArgsMode {
  if (Array.isArray(cmd.args)) {
    const specs: ArgsMode["specs"] = [];
    for (const a of cmd.args as ArgSpec[]) {
      if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name.trim()) continue;
      const prefix = typeof a.prefix === "string" ? a.prefix : undefined;
      const suffix = typeof a.suffix === "string" ? a.suffix : undefined;
      let description = typeof a.description === "string" ? a.description : `Value for ${a.name}`;
      if (prefix !== undefined || suffix !== undefined) {
        description += ` Passed as ${prefix ?? ""}<value>${suffix ?? ""}.`;
      }
      specs.push({
        name: a.name,
        description,
        required: a.required === true,
        default: a.default !== undefined && a.default !== null ? String(a.default) : undefined,
        prefix,
        suffix,
      });
    }
    return { mode: specs.length ? "named" : "none", specs };
  }
  return { mode: cmd.args === true ? "free" : "none", specs: [] };
}

/** Glues the literal decoration around the shell-quoted value. */
function decorate(spec: ArgsMode["specs"][number], value: string): string {
  return `${spec.prefix ?? ""}${shellQuote(value)}${spec.suffix ?? ""}`;
}

/** Renders one argument for previews: its default, or a required/optional
 * marker, wrapped in the declared decoration. The inner quotes are part of
 * the preview text. */
function argPreview(spec: ArgsMode["specs"][number]): string {
  const inner =
    spec.default !== undefined
      ? `${spec.name}=${spec.default}`
      : spec.required
        ? `<${spec.name}>`
        : `[${spec.name}]`;
  return `${spec.prefix ?? ""}'${inner}'${spec.suffix ?? ""}`;
}

/** The static preview of a command line: what will run, with argument
 * placeholders, for docs and list_commands. Values never appear. */
export function previewCommandline(entry: ToolEntry): string {
  const { cmd, args } = entry;
  let base = cmd.command;
  let placeholders = "";
  if (args.mode === "free") {
    placeholders = " '<free args…>'";
  } else if (args.mode === "named") {
    const filled = commandPlaceholders(cmd.command);
    for (const ph of filled) {
      const spec = args.specs.find((s) => s.name === ph);
      if (!spec) continue;
      base = base.split(`{${ph}}`).join(argPreview(spec));
    }
    placeholders = args.specs
      .filter((s) => !filled.includes(s.name))
      .map((s) => ` ${argPreview(s)}`)
      .join("");
  }
  const parsed = typeof cmd.pipe === "string" && cmd.pipe.trim() ? ` | ${cmd.pipe}` : "";
  return base + placeholders + parsed;
}

/** The effective argument value for a spec: the passed value, or the
 * declared default. An error when a required argument is missing; undefined
 * when absent with no default. */
function resolveArgValue(
  spec: ArgsMode["specs"][number],
  values: Record<string, unknown>,
): { value: unknown } | { error: string } {
  const v = values[spec.name];
  if (v !== undefined && v !== null && v !== "") return { value: v };
  if (spec.required) return { error: `Missing required argument "${spec.name}".` };
  return { value: spec.default };
}

/** Fills every {placeholder} in the command line with its declared argument,
 * shell-quoted; an empty value leaves nothing in its place. */
function fillPlaceholders(
  cmdText: string,
  args: ArgsMode,
  values: Record<string, unknown>,
  placeholderNames: string[],
): string | { error: string } {
  let template = cmdText;
  for (const ph of placeholderNames) {
    const spec = args.specs.find((s) => s.name === ph);
    if (!spec) return { error: `Placeholder "{${ph}}" has no matching named argument.` };
    const resolved = resolveArgValue(spec, values);
    if ("error" in resolved) return resolved;
    const v = resolved.value;
    template = template
      .split(`{${ph}}`)
      .join(v === undefined || v === null || v === "" ? "" : decorate(spec, String(v)));
  }
  return template;
}

/** Appends named arguments that the command line has no placeholder for, in
 * declared order. */
function appendRemainingArgs(
  template: string,
  args: ArgsMode,
  values: Record<string, unknown>,
  placeholderNames: string[],
): string | { error: string } {
  const list: string[] = [];
  for (const spec of args.specs) {
    if (placeholderNames.includes(spec.name)) continue;
    const resolved = resolveArgValue(spec, values);
    if ("error" in resolved) return resolved;
    if (resolved.value === undefined) continue;
    list.push(decorate(spec, String(resolved.value)));
  }
  return list.length ? `${template} ${list.join(" ")}` : template;
}

/** Builds the final command line for a call, or an error object when the
 * arguments do not fit the declared ones. */
export function buildCommandline(entry: ToolEntry, argValues: unknown): string | { error: string } {
  const { cmd, args } = entry;
  if (args.mode === "none") return cmd.command;
  if (args.mode === "free") {
    const list = Array.isArray(argValues) ? argValues.map(String) : [];
    return list.length ? `${cmd.command} ${list.map(shellQuote).join(" ")}` : cmd.command;
  }
  const values: Record<string, unknown> =
    argValues && typeof argValues === "object" && !Array.isArray(argValues)
      ? (argValues as Record<string, unknown>)
      : {};
  for (const key of Object.keys(values)) {
    if (!args.specs.some((s) => s.name === key)) {
      return {
        error: `Unknown argument "${key}". Allowed: ${args.specs.map((s) => s.name).join(", ")}.`,
      };
    }
  }
  const placeholderNames = commandPlaceholders(cmd.command);
  const filled = fillPlaceholders(cmd.command, args, values, placeholderNames);
  if (typeof filled !== "string") return filled;
  const command = appendRemainingArgs(filled, args, values, placeholderNames);
  if (typeof command !== "string") return command;
  if (!command.trim()) return { error: "Command is empty after argument substitution." };
  return command;
}
