import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@prefecthq/fastmcp-ts/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { ShellRunnerServer } from "../src/server/index.js";
import { loadConfig } from "../src/config/index.js";
import { makeTmp, writeConfig } from "./helpers.js";

const tmp = makeTmp("sr-session-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The fastmcp client talking to a ShellRunnerServer over an in-memory
 * transport pair, with the config file scoped to the test. */
async function makeSession(configText: string) {
  const cfgPath = writeConfig(tmp, configText);
  const prev = process.env.SHELL_RUNNER_CONFIG;
  process.env.SHELL_RUNNER_CONFIG = cfgPath;
  const srs = new ShellRunnerServer();
  const client = await Client.connect(srs);
  return {
    client,
    srs,
    cfgPath,
    restore: () => {
      if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
      else process.env.SHELL_RUNNER_CONFIG = prev;
    },
  };
}

describe("ShellRunnerServer over fastmcp", () => {
  it("initializes with the shell-runner server info and listChanged capability", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    try {
      expect(s.client.getServerInfo()).toMatchObject({ name: "shell-runner", version: "1.1" });
      expect(s.client.getServerCapabilities()?.tools).toMatchObject({ listChanged: true });
    } finally {
      s.restore();
    }
  });

  it("serves declared tools and the built-ins on tools/list", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    try {
      const tools = await s.client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "list_commands",
        "config_template",
        "config_schema",
        "save_command",
        "remove_command",
        "g__ok",
      ]);
      const declared = tools.find((t) => t.name === "g__ok");
      expect(declared?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      s.restore();
    }
  });

  it("serves the bundled JSON schema through config_schema", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    try {
      const result = await s.client.callToolRaw("config_schema", {});
      expect(result.isError).toBeFalsy();
      const schema = JSON.parse((result.content as any)[0].text);
      expect(schema.$schema).toContain("json-schema");
      expect(schema.definitions.outputTo).toBeDefined();
      expect(schema.additionalProperties.properties.commands).toBeDefined();
    } finally {
      s.restore();
    }
  });

  it("runs commands through tools/call and strips undeclared arguments", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo hello\n");
    try {
      const ok = await s.client.callToolRaw("g__ok", {});
      expect(ok.isError).toBeFalsy();
      expect((ok.content as any)[0].text).toContain("exit code: 0");
      // A no-args tool ignores whatever the agent sends: zod strips undeclared
      // keys, so the command still runs exactly as configured.
      const noisy = await s.client.callToolRaw("g__ok", { nope: "x" });
      expect(noisy.isError).toBeFalsy();
      expect((noisy.content as any)[0].text).toContain("hello");
    } finally {
      s.restore();
    }
  });

  it("passes named arguments and drops output_to when not enabled", async () => {
    const s = await makeSession(
      [
        "g:",
        "  commands:",
        "    - label: Greet",
        "      command: echo",
        "      args:",
        "        - name: who",
        "          required: true",
      ].join("\n"),
    );
    try {
      const ok = await s.client.callToolRaw("g__greet", { who: "world" });
      expect((ok.content as any)[0].text).toContain("world");
      // output_to is not in this tool's schema, so zod strips it and the run
      // proceeds; rejecting unrequested file output is the schema's job.
      const ignored = await s.client.callToolRaw("g__greet", { who: "x", output_to: true });
      expect(ignored.isError).toBeFalsy();
      expect((ignored.content as any)[0].text).toContain("x");
    } finally {
      s.restore();
    }
  });

  it("gates destructive commands behind acknowledge_destructive", async () => {
    const marker = path.join(tmp, "destroyed.txt");
    const s = await makeSession(
      [
        "g:",
        "  commands:",
        "    - label: Wipe",
        `      command: touch ${marker}`,
        "      destructive: true",
      ].join("\n"),
    );
    try {
      const refused = await s.client.callToolRaw("g__wipe", {});
      expect(refused.isError).toBe(true);
      expect((refused.content as any)[0].text).toBe(
        "This command is declared destructive. Call it again with acknowledge_destructive: true.",
      );
      expect(fs.existsSync(marker)).toBe(false);

      const explicitNo = await s.client.callToolRaw("g__wipe", { acknowledge_destructive: false });
      expect(explicitNo.isError).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);

      const ok = await s.client.callToolRaw("g__wipe", { acknowledge_destructive: true });
      expect(ok.isError).toBeFalsy();
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      s.restore();
    }
  });

  it("gates nature: destructive commands the same way", async () => {
    const marker = path.join(tmp, "nature-destroyed.txt");
    const s = await makeSession(
      [
        "g:",
        "  commands:",
        "    - label: Wipe",
        `      command: touch ${marker}`,
        "      nature: destructive",
      ].join("\n"),
    );
    try {
      const refused = await s.client.callToolRaw("g__wipe", {});
      expect(refused.isError).toBe(true);
      expect((refused.content as any)[0].text).toContain("acknowledge_destructive: true");
      expect(fs.existsSync(marker)).toBe(false);

      const ok = await s.client.callToolRaw("g__wipe", { acknowledge_destructive: true });
      expect(ok.isError).toBeFalsy();
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      s.restore();
    }
  });

  it("refuses a save_command proposal that is both read_only and destructive", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    try {
      const r = await s.client.callToolRaw("save_command", {
        group: "agent-tools",
        label: "Both",
        command: "echo",
        read_only: true,
        destructive: true,
      });
      expect(r.isError).toBe(true);
      expect((r.content as any)[0].text).toContain('cannot be both "read_only" and "destructive"');
    } finally {
      s.restore();
    }
  });

  it("exposes the output_to argument only when the config allows the agent", async () => {
    const s = await makeSession(
      [
        "g:",
        "  commands:",
        "    - label: Allowed",
        "      command: echo",
        "      output_to:",
        "        dir: logs/",
        "        allow_agent: true",
        "    - label: Forbidden",
        "      command: echo",
      ].join("\n"),
    );
    try {
      const tools = await s.client.listTools();
      const schema = (name: string) =>
        (tools.find((t) => t.name === name)?.inputSchema as any)?.properties;
      expect(schema("g__allowed")?.output_to).toBeTruthy();
      expect(schema("g__forbidden")?.output_to).toBeUndefined();
    } finally {
      s.restore();
    }
  });

  it("cancels an in-flight call through the client abort signal", async () => {
    const s = await makeSession(
      "g:\n  commands:\n    - label: Slow\n      command: sleep 30\n      timeout: 20\n",
    );
    try {
      const controller = new AbortController();
      const started = Date.now();
      const call = s.client.callTool("g__slow", {}, { signal: controller.signal });
      setTimeout(() => controller.abort(), 250);
      await expect(call).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      s.restore();
    }
  }, 10000);

  it("re-registers tools only when the config signature changes", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: A\n      command: echo one\n");
    try {
      const first = await s.client.callTool("list_commands");
      expect((first.content as any)[0].text).toContain("g__a");
      // Same tool set: no re-registration.
      expect(s.srs.syncTools(loadConfig())).toBe(false);
      fs.writeFileSync(
        s.cfgPath,
        "g:\n  commands:\n    - label: A\n      command: echo two\n    - label: B\n      command: echo b\n",
      );
      // The tool set changed: a rebuild happens on the next reload...
      expect(s.srs.syncTools(loadConfig())).toBe(true);
      // ...and the fresh list serves the new command.
      const tools = await s.client.listTools();
      expect(tools.map((t) => t.name)).toContain("g__b");
      const second = await s.client.callTool("list_commands");
      expect((second.content as any)[0].text).toContain("g__b");
    } finally {
      s.restore();
    }
  });

  it("answers unknown tools with a protocol error", async () => {
    const s = await makeSession("g:\n  commands:\n    - label: Ok\n      command: echo\n");
    try {
      await expect(s.client.callTool("g__missing", {})).rejects.toThrow(/Unknown tool/);
    } finally {
      s.restore();
    }
  });
});
