// The MCP protocol layer, on @prefecthq/fastmcp-ts. The framework owns the
// JSON-RPC plumbing: initialize, ping, tools/list serving, result conversion
// and the tools/list_changed notifications (emitted by tool()/_removeTool).
// This module only registers tools and keeps the registered set in sync with
// the config file. The binary entry point lives in main.ts.

import {
  CancellationMiddleware,
  FastMCP,
  ToolResult,
  inputRequired,
  inputResponse,
} from "@prefecthq/fastmcp-ts/server";
import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  agentConfigPath,
  emitAgentGroups,
  type LoadedConfig,
  loadConfig,
  readAgentGroups,
  removeAgentCommand,
  resolveOutputTo,
  upsertAgentCommand,
  validateAgentProposal,
  withAgentLock,
} from "../config/index.js";
import { BUILTIN_TOOLS, flattenTools } from "../tools/index.js";
import { configSchemaPath, doctorReport, emitConfigTemplate } from "../report/index.js";
import { runEntry } from "../runner/index.js";
import { requestSignal, signalMiddleware } from "./middleware.js";
import type { z } from "zod";
import { argValuesFor, removeCommandInput, saveCommandInput, zodInput } from "./schemas.js";

export const SERVER_VERSION = "1.0";

/** The approval form shown to the human: one explicit boolean, so a accept
 * is always a deliberate answer and never a default. */
const APPROVE_SCHEMA = {
  type: "object" as const,
  properties: {
    approve: {
      type: "boolean" as const,
      title: "Approve",
      description: "true applies this change to the agent config file now",
    },
  },
  required: ["approve"],
};

/** The command fields of a save_command proposal, extracted and defaulted. */
function proposalFrom(args: Record<string, unknown>): {
  group: string;
  meta: { description?: string; trigger?: string };
  cmd: Record<string, unknown>;
} {
  const { group, group_description, group_trigger, ...cmd } = args;
  return {
    group: group as string,
    meta: {
      description: group_description as string | undefined,
      trigger: group_trigger as string | undefined,
    },
    cmd,
  };
}

/** The exact YAML block the human is asked to approve. */
function proposalPreview(
  group: string,
  meta: { description?: string; trigger?: string },
  cmd: Record<string, unknown>,
): string {
  return emitAgentGroups({ [group]: { ...meta, commands: [cmd] } }).trimEnd();
}

/**
 * The tool a saved command ended up as, or null when the merged config does
 * not expose it (a human group shadowed it mid-approval, say).
 */
function savedToolEntry(cfg: LoadedConfig, group: string, name: string) {
  return flattenTools(cfg.groups, cfg.defaults).find(
    (t) => !("builtin" in t.entry) && t.entry.groupKey === group && t.entry.cmd.label === name,
  );
}

export class ShellRunnerServer {
  readonly server: FastMCP;
  private registered: string[] = [];
  private lastSignature: string | null = null;

  constructor(server?: FastMCP) {
    this.server =
      server ??
      new FastMCP({
        name: "shell-runner",
        version: SERVER_VERSION,
        middleware: [signalMiddleware, new CancellationMiddleware()],
      });
    this.syncTools(loadConfig());
  }

  /** A fingerprint of everything tools/list serves, so config edits are
   * detected without polling. */
  private signature(cfg: LoadedConfig): string | null {
    try {
      return JSON.stringify([
        flattenTools(cfg.groups, cfg.defaults).map((t) => t.schema),
        cfg.issues,
      ]);
    } catch {
      return null;
    }
  }

  /** Re-reads the config and re-syncs the tool set; the file is re-read on
   * every call. Re-registering makes fastmcp emit
   * notifications/tools/list_changed itself; no manual send needed. */
  private reload = async (): Promise<LoadedConfig> => {
    const current = loadConfig();
    this.syncTools(current);
    return current;
  };

  /**
   * What each read-only built-in renders from the freshly loaded config.
   */
  private static readonly BUILTIN_RENDERERS: Record<string, (cfg: LoadedConfig) => string> = {
    list_commands: doctorReport,
    template: emitConfigTemplate,
    // The schema is static, so the loaded config is irrelevant.
    schema: () => readFileSync(configSchemaPath(), "utf8"),
  };

  /**
   * A refusal the agent can act on: nothing was written.
   */
  private static refuse(text: string): ToolResult {
    return new ToolResult({
      content: [{ type: "text" as const, text }],
      isError: true,
    });
  }

  /** The approval answer of this request, when the human already responded. */
  private approval(): "accept" | "decline" | "pending" {
    const view = inputResponse(this.server.getContext().inputResponses, "approve");
    if (view.kind !== "elicit") return "pending";
    return view.action === "accept" ? "accept" : "decline";
  }

  /** Guards shared by both proposal tools: the agent file must be in play.
   * A refusal comes back as a ToolResult; success carries the file path. */
  private proposalGate(cfg: LoadedConfig): ToolResult | { agentPath: string } {
    const agentPath = agentConfigPath();
    if (cfg.explicit || !agentPath) {
      return ShellRunnerServer.refuse(
        "$SHELL_RUNNER_CONFIG is set, so it is used alone and agent proposals cannot apply. " +
          "Ask the human to add the command to that file by hand.",
      );
    }
    return { agentPath };
  }

  /**
   * save_command: validate, ask the human, write on approval.
   */
  private async proposeSave(args: Record<string, unknown>): Promise<unknown> {
    const cfg = await this.reload();
    const { group, meta, cmd } = proposalFrom(args);
    if (cmd.read_only === true && cmd.destructive === true) {
      return ShellRunnerServer.refuse(
        'a proposal cannot be both "read_only" and "destructive"; nothing was written.',
      );
    }
    const gate = this.proposalGate(cfg);
    if (gate instanceof ToolResult) return gate;
    const { agentPath } = gate;

    const answer = this.approval();
    if (answer === "decline") {
      return ShellRunnerServer.refuse(
        "the human declined this proposal; nothing was written. Do not retry it unchanged.",
      );
    }
    if (answer === "pending") {
      const agentGroups = readAgentGroups(agentPath);
      if (cfg.groups[group] && !(group in agentGroups)) {
        return ShellRunnerServer.refuse(
          `group "${group}" already exists in a human config (the trusted store or ` +
            `user-global), so the agent cannot add commands to it. Ask the human to add the ` +
            `command there, or propose a new group.`,
        );
      }
      const issues = validateAgentProposal(agentPath, group, meta, cmd);
      if (issues.length) {
        return ShellRunnerServer.refuse(
          `the proposal is not valid, nothing was written:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
        );
      }
      const replacing = (agentGroups[group]?.commands ?? []).some(
        (c: any) => c && c.label === cmd.label,
      );
      return inputRequired({
        inputRequests: {
          approve: inputRequired.elicit({
            message:
              `The agent wants to ${replacing ? "update" : "add"} a command in ${agentPath}:\n\n` +
              `${proposalPreview(group, meta, cmd)}\n\n` +
              `Approving writes it and exposes the tool immediately.`,
            requestedSchema: APPROVE_SCHEMA,
          }),
        },
      });
    }

    // The human approved what round 1 validated. The write re-validates, so
    // an edit that raced the approval is still refused, never half-applied.
    try {
      const { replaced } = await withAgentLock(() =>
        upsertAgentCommand(agentPath, group, meta, cmd),
      );
      const current = await this.reload();
      const tool = savedToolEntry(current, group, String(cmd.label));
      const tail = tool
        ? `The tool ${tool.schema.name} is available now.`
        : `The command is saved, but no tool exposes it right now: the group is shadowed by a ` +
          `human config group of the same name. Call list_commands for details.`;
      return new ToolResult({
        content: [
          {
            type: "text" as const,
            text:
              `${replaced ? "Updated" : "Saved"}: the human approved "${cmd.label}" in group ` +
              `"${group}". Written to ${agentPath}. ${tail}`,
          },
        ],
      });
    } catch (e: any) {
      return ShellRunnerServer.refuse(`the command could not be saved: ${e.message}`);
    }
  }

  /**
   * remove_command: confirm with the human, rewrite the agent file.
   */
  private async proposeRemove(args: Record<string, unknown>): Promise<unknown> {
    const cfg = await this.reload();
    const gate = this.proposalGate(cfg);
    if (gate instanceof ToolResult) return gate;
    const { agentPath } = gate;
    const group = String(args.group);
    const label = String(args.label);

    const findTarget = () =>
      (readAgentGroups(agentPath)[group]?.commands ?? []).find((c: any) => c && c.label === label);

    const answer = this.approval();
    if (answer === "decline") {
      return ShellRunnerServer.refuse(
        "the human declined this proposal; nothing was written. Do not retry it unchanged.",
      );
    }
    if (answer === "pending") {
      const target = findTarget();
      if (!target) {
        return ShellRunnerServer.refuse(
          `"${label}" is not an agent-proposed command in group "${group}". Only commands ` +
            `previously approved through save_command can be removed here; ask the human to ` +
            `edit the config file for anything else.`,
        );
      }
      return inputRequired({
        inputRequests: {
          approve: inputRequired.elicit({
            message:
              `The agent wants to remove the command "${label}" from group "${group}" ` +
              `in ${agentPath}:\n\n${proposalPreview(group, {}, target)}\n\n` +
              `Approving removes the command and its tool immediately.`,
            requestedSchema: APPROVE_SCHEMA,
          }),
        },
      });
    }

    // The human approved what round 1 previewed; remove it now. An external
    // edit can still have beaten the write to it.
    const removed = await withAgentLock(() => removeAgentCommand(agentPath, group, label));
    if (!removed) {
      return ShellRunnerServer.refuse(
        `"${label}" is no longer in group "${group}"; nothing to remove.`,
      );
    }
    await this.reload();
    return new ToolResult({
      content: [
        {
          type: "text" as const,
          text:
            `Removed: the human approved removing "${label}" from group "${group}". ` +
            `Written to ${agentPath}; the tool is gone.`,
        },
      ],
    });
  }

  /**
   * Registers the built-ins: the read-only renderers and the two proposal
   * tools whose writes are gated by human elicitation approval.
   */
  private registerBuiltinTools(): void {
    const actions: Record<
      string,
      ((args: Record<string, unknown>) => Promise<unknown>) | undefined
    > = {
      save_command: (args) => this.proposeSave(args),
      remove_command: (args) => this.proposeRemove(args),
    };
    const zodInputs: Record<string, z.ZodObject | undefined> = {
      save_command: saveCommandInput,
      remove_command: removeCommandInput,
    };
    for (const builtin of BUILTIN_TOOLS) {
      const action = actions[builtin.builtin];
      const render = ShellRunnerServer.BUILTIN_RENDERERS[builtin.builtin] as
        | ((cfg: LoadedConfig) => string)
        | undefined;
      this.server.tool(
        {
          name: builtin.schema.name,
          title: builtin.schema.title,
          description: builtin.schema.description,
          ...(action ? { input: zodInputs[builtin.builtin] } : {}),
          inputSchema: builtin.schema.inputSchema,
          annotations: builtin.schema.annotations,
        },
        action ?? (async () => render?.(await this.reload())),
      );
      this.registered.push(builtin.schema.name);
    }
  }

  /** Registers one tool per declared command with its zod input validator and
   * the run handler enforcing the output contract. */
  private registerCommandTools(cfg: LoadedConfig): void {
    for (const tool of flattenTools(cfg.groups, cfg.defaults)) {
      if ("builtin" in tool.entry) continue;
      const entry = tool.entry;
      const outputToAllowed =
        resolveOutputTo(entry.cmd, entry.group, cfg.defaults)?.allow_agent === true;
      this.server.tool(
        {
          name: tool.schema.name,
          title: tool.schema.title,
          description: tool.schema.description,
          input: zodInput(entry, outputToAllowed),
          inputSchema: tool.schema.inputSchema,
          annotations: tool.schema.annotations,
        },
        async (parsed: Record<string, unknown>) => {
          if (entry.cmd.destructive === true && parsed.acknowledge_destructive !== true) {
            return ShellRunnerServer.refuse(
              "This command is declared destructive. Call it again with acknowledge_destructive: true.",
            );
          }
          const current = await this.reload();
          const result = await runEntry(
            entry,
            argValuesFor(entry, parsed),
            current.defaults,
            requestSignal(this.server),
            parsed.output_to,
          );
          return new ToolResult({
            content: [{ type: "text" as const, text: result.text }],
            isError: result.isError,
          });
        },
      );
      this.registered.push(tool.schema.name);
    }
  }

  /** Registers the built-ins and one tool per declared command. The tool set
   * is rebuilt whenever the signature changes; returns whether it did. */
  syncTools(cfg: LoadedConfig): boolean {
    const signature = this.signature(cfg);
    if (signature === this.lastSignature) return false;
    for (const name of this.registered) this.server._removeTool(name);
    this.registered = [];
    this.registerBuiltinTools();
    this.registerCommandTools(cfg);
    this.lastSignature = signature;
    return true;
  }

  /** Serves the server over stdio; resolves when the transport closes.
   * Std streams are injectable for tests. */
  async serve(options?: { stdin?: Readable; stdout?: Writable }): Promise<void> {
    await this.server.run({ transport: "stdio", ...options });
  }

  /** Connects a caller-owned transport (in-process transports in tests); the
   * wire shape is fastmcp's own Transport. */
  async connect(transport: Parameters<FastMCP["connect"]>[0]): Promise<void> {
    await this.server.connect(transport);
  }
}
