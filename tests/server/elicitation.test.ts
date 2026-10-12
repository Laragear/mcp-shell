import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@prefecthq/fastmcp-ts/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { ShellRunnerServer } from "../../src/server/index.js";
import { agentConfigPath, removeAgentCommand, storeConfigPath } from "../../src/config/index.js";
import { makeTmp, withEnv } from "../helpers.js";

const tmp = makeTmp("sr-elicit-");
const home = makeTmp("sr-elicit-home-");
afterAll(() => {
  for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs fn with the tmp project and home, regardless of the current env. */
function inTmpEnv<T>(fn: () => T): T {
  return withEnv(
    {
      SHELL_RUNNER_PROJECT_DIR: tmp,
      SHELL_RUNNER_HOME: home,
      SHELL_RUNNER_CONFIG: undefined,
    },
    fn,
  );
}

const agentFile = () => inTmpEnv(() => agentConfigPath() as string);

/** The trusted store config of the tmp project (a human-written file). */
const humanStore = () => inTmpEnv(() => storeConfigPath());

/** A session scoped to the tmp project: no explicit config, so the agent
 * file applies. The elicitation handler answers every approval dialog. */
async function session(
  elicitation?: (params: any) => any,
): Promise<{ client: Client; restore: () => void }> {
  const prev = { ...process.env };
  process.env.SHELL_RUNNER_PROJECT_DIR = tmp;
  process.env.SHELL_RUNNER_HOME = home;
  delete process.env.SHELL_RUNNER_CONFIG;
  const agent = agentConfigPath() as string;
  const srs = new ShellRunnerServer();
  const client = await Client.connect(srs, elicitation ? { handlers: { elicitation } } : undefined);
  return {
    client,
    restore: () => {
      client.close();
      process.env = prev;
      fs.rmSync(agent, { force: true });
    },
  };
}

const APPROVE = () => ({ action: "accept", content: { approve: true } });
const SAVE_ARGS = {
  group: "frontend",
  label: "Run tests",
  command: "echo test-run-ok",
  description: "Runs the unit tests",
  read_only: true,
  group_description: "Frontend commands",
};

/** The tool result text of a save/remove call. */
function text(result: any): string {
  return (result.content as any[]).map((c) => c.text).join("");
}

describe("agent-proposed commands over elicitation", () => {
  it("asks the human, writes on approval and exposes the tool immediately", async () => {
    const asked: any[] = [];
    const s = await session((params) => {
      asked.push(params);
      return APPROVE();
    });
    try {
      const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("frontend__run_tests");
      expect(text(result)).toContain("Saved");
      // The dialog carried the exact YAML of the proposal.
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toContain("echo test-run-ok");
      expect(asked[0].message).toContain("agent.yaml");
      // The file landed with the emitted document.
      const written = fs.readFileSync(agentFile(), "utf8");
      expect(written).toContain("frontend:");
      expect(written).toContain("command: echo test-run-ok");
      // The new tool is listed and runs.
      const tools = (await s.client.listTools()).map((t) => t.name);
      expect(tools).toContain("frontend__run_tests");
      const run = await s.client.callToolRaw("frontend__run_tests", {});
      expect(run.isError).toBeFalsy();
      expect((run.content as any)[0].text).toContain("test-run-ok");
      // The doctor report marks the group as agent-proposed.
      const doctor = text(await s.client.callToolRaw("list_commands", {}));
      expect(doctor).toContain("Agent file:");
      expect(doctor).toContain("## frontend (agent-proposed)");
    } finally {
      s.restore();
    }
  });

  it("updates an existing agent command in place", async () => {
    const s = await session(() => APPROVE());
    try {
      await s.client.callToolRaw("save_command", SAVE_ARGS);
      const second = await s.client.callToolRaw("save_command", {
        ...SAVE_ARGS,
        command: "npm run test:all",
      });
      expect(text(second)).toContain("Updated");
      const written = fs.readFileSync(agentFile(), "utf8");
      expect(written).toContain("npm run test:all");
      expect(written).not.toContain("command: npm test\n");
    } finally {
      s.restore();
    }
  });

  it("writes nothing when the human declines", async () => {
    const s = await session(() => ({ action: "decline" }));
    try {
      const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("declined");
      expect(fs.existsSync(agentFile())).toBe(false);
    } finally {
      s.restore();
    }
  });

  it("refuses cleanly when the client cannot elicit", async () => {
    const s = await session();
    try {
      let failed = false;
      try {
        const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
        failed = result.isError === true;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(fs.existsSync(agentFile())).toBe(false);
    } finally {
      s.restore();
    }
  });

  it("refuses to add commands to a group a human config declares", async () => {
    const human = humanStore();
    fs.mkdirSync(path.dirname(human), { recursive: true });
    fs.writeFileSync(
      human,
      "frontend:\n  commands:\n    - label: Human owned\n      command: echo mine\n",
    );
    const s = await session(() => APPROVE());
    try {
      const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("human config");
      expect(fs.existsSync(agentFile())).toBe(false);
    } finally {
      s.restore();
      fs.rmSync(human, { force: true });
    }
  });

  it("rejects invalid proposals before asking the human", async () => {
    let asked = 0;
    const s = await session(() => {
      asked++;
      return APPROVE();
    });
    try {
      const result = await s.client.callToolRaw("save_command", {
        group: "g",
        label: "Bad",
        command: "rm {file}",
      });
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("placeholder {file}");
      expect(asked).toBe(0);
      expect(fs.existsSync(agentFile())).toBe(false);
    } finally {
      s.restore();
    }
  });

  it("refuses proposals while $SHELL_RUNNER_CONFIG is authoritative", async () => {
    const explicit = path.join(tmp, "explicit.yaml");
    fs.writeFileSync(explicit, "ex:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    const prev = process.env.SHELL_RUNNER_CONFIG;
    process.env.SHELL_RUNNER_CONFIG = explicit;
    try {
      const srs = new ShellRunnerServer();
      const client = await Client.connect(srs);
      const result = await client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("SHELL_RUNNER_CONFIG");
      client.close();
    } finally {
      if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
      else process.env.SHELL_RUNNER_CONFIG = prev;
      fs.rmSync(explicit, { force: true });
    }
  });

  it("removes agent commands after approval and only those", async () => {
    const s = await session(() => APPROVE());
    try {
      await s.client.callToolRaw("save_command", SAVE_ARGS);
      const human = humanStore();
      fs.mkdirSync(path.dirname(human), { recursive: true });
      fs.writeFileSync(
        human,
        "hum:\n  commands:\n    - label: Human owned\n      command: echo mine\n",
      );
      // A human command is not removable through the agent tools.
      const refused = await s.client.callToolRaw("remove_command", {
        group: "hum",
        label: "Human owned",
      });
      expect(refused.isError).toBeTruthy();
      expect(text(refused)).toContain("agent-proposed");
      // The agent command goes away after the dialog.
      const result = await s.client.callToolRaw("remove_command", {
        group: "frontend",
        label: "Run tests",
      });
      expect(result.isError).toBeFalsy();
      expect(fs.readFileSync(agentFile(), "utf8")).not.toContain("echo test-run-ok");
      const tools = (await s.client.listTools()).map((t) => t.name);
      expect(tools).not.toContain("frontend__run_tests");
      // Removing it again has nothing to act on.
      const again = await s.client.callToolRaw("remove_command", {
        group: "frontend",
        label: "Run tests",
      });
      expect(again.isError).toBeTruthy();
      fs.rmSync(human, { force: true });
    } finally {
      s.restore();
    }
  });

  it("writes nothing when the human declines a removal", async () => {
    let calls = 0;
    const s = await session(() => (++calls === 1 ? APPROVE() : { action: "decline" }));
    try {
      await s.client.callToolRaw("save_command", SAVE_ARGS);
      const result = await s.client.callToolRaw("remove_command", {
        group: "frontend",
        label: "Run tests",
      });
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("declined");
      expect(fs.readFileSync(agentFile(), "utf8")).toContain("echo test-run-ok");
    } finally {
      s.restore();
    }
  });

  it("refuses proposals when the explicit config path is set but missing", async () => {
    const prev = process.env.SHELL_RUNNER_CONFIG;
    process.env.SHELL_RUNNER_CONFIG = path.join(tmp, "nope.yaml");
    try {
      const srs = new ShellRunnerServer();
      const client = await Client.connect(srs);
      const result = await client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("SHELL_RUNNER_CONFIG");
      const remove = await client.callToolRaw("remove_command", {
        group: "frontend",
        label: "Run tests",
      });
      expect(remove.isError).toBeTruthy();
      expect(text(remove)).toContain("SHELL_RUNNER_CONFIG");
      client.close();
    } finally {
      if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
      else process.env.SHELL_RUNNER_CONFIG = prev;
    }
  });

  it("still answers when the approved group is shadowed by a human config mid-dialog", async () => {
    const s = await session(() => {
      // A human config appears while the human looks at the dialog.
      const human = humanStore();
      fs.mkdirSync(path.dirname(human), { recursive: true });
      fs.writeFileSync(
        human,
        "frontend:\n  commands:\n    - label: Human owned\n      command: echo mine\n",
      );
      return APPROVE();
    });
    try {
      const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain("shadowed by a human config group");
      // The doctor report explains why the tool is not actually exposed.
      const doctor = text(await s.client.callToolRaw("list_commands", {}));
      expect(doctor).toContain("shadowed by a config group");
    } finally {
      s.restore();
      fs.rmSync(humanStore(), { force: true });
    }
  });

  it("refuses the write when the agent file turns unparseable during the dialog", async () => {
    const s = await session(() => {
      // The file gets mangled while the human looks at the dialog.
      fs.mkdirSync(path.dirname(agentFile()), { recursive: true });
      fs.writeFileSync(agentFile(), "a: &anchor b\n");
      return APPROVE();
    });
    try {
      const result = await s.client.callToolRaw("save_command", SAVE_ARGS);
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("could not be saved");
    } finally {
      s.restore();
    }
  });

  it("reports a command that vanished while the dialog was open", async () => {
    const s = await session(() => {
      // The command disappears between the proposal and the approval.
      removeAgentCommand(agentFile(), "frontend", "Run tests");
      return APPROVE();
    });
    try {
      await s.client.callToolRaw("save_command", SAVE_ARGS);
      const result = await s.client.callToolRaw("remove_command", {
        group: "frontend",
        label: "Run tests",
      });
      expect(result.isError).toBeTruthy();
      expect(text(result)).toContain("no longer");
    } finally {
      s.restore();
    }
  });
});
