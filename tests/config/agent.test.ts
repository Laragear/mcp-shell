import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  agentConfigPath,
  emitAgentGroups,
  loadConfig,
  readAgentGroups,
  removeAgentCommand,
  storeConfigPath,
  upsertAgentCommand,
  validateAgentProposal,
  withAgentLock,
  writeAgentGroups,
} from "../../src/config/index.js";
import { makeTmp, withEnv } from "../helpers.js";

const tmp = makeTmp("sr-agent-");
const home = makeTmp("sr-agent-home-");
afterAll(() => {
  for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true });
});

/** The agent file path: next to the trusted store of the tmp project. */
function agentFile(): string {
  return withEnv(
    {
      SHELL_RUNNER_PROJECT_DIR: tmp,
      SHELL_RUNNER_HOME: home,
      SHELL_RUNNER_CONFIG: undefined,
    },
    () => agentConfigPath() as string,
  );
}

/** The trusted store config path of the tmp project. */
function storeFile(): string {
  return withEnv(
    {
      SHELL_RUNNER_PROJECT_DIR: tmp,
      SHELL_RUNNER_HOME: home,
      SHELL_RUNNER_CONFIG: undefined,
    },
    () => storeConfigPath(),
  );
}

/** Loads the effective config with the tmp project and an empty home. */
function loadInTmp(): ReturnType<typeof loadConfig> {
  return withEnv(
    {
      SHELL_RUNNER_PROJECT_DIR: tmp,
      SHELL_RUNNER_HOME: home,
      SHELL_RUNNER_CONFIG: undefined,
    },
    () => loadConfig(),
  );
}

describe("agent config file", () => {
  it("emits a document that round-trips through the parser", () => {
    const groups = {
      deploy: {
        description: "Ship it",
        trigger: "On request",
        env: { CI: "true" },
        commands: [
          {
            label: "Build all",
            command: "vue-tsc --noEmit\nvite build",
            description: "Type-checks then builds",
            args: [
              {
                name: "target",
                description: "Build target",
                required: true,
                default: "web",
                prefix: "--target ",
                suffix: ":rw",
              },
            ],
            timeout: 300,
            cwd: "./web",
            pipe: "tail -20",
            check: { contains: ["done"], not_contains: ["FAIL"] },
            max_output: 5000,
            read_only: true,
            env: { NODE_ENV: "production" },
          },
        ],
      },
      "tricky group": {
        commands: [{ label: "Quote: me", command: "echo it's" }],
      },
    };
    const text = emitAgentGroups(groups);
    fs.mkdirSync(path.dirname(agentFile()), { recursive: true });
    fs.writeFileSync(agentFile(), text);
    expect(readAgentGroups(agentFile())).toEqual(groups);
  });

  it("emits a bare argument with only a name", () => {
    const groups = { g: { commands: [{ label: "A", command: "echo", args: [{ name: "x" }] }] } };
    const file = path.join(tmp, "bare-arg.yaml");
    fs.writeFileSync(file, emitAgentGroups(groups));
    expect(readAgentGroups(file)).toEqual(groups);
  });

  it("reads an empty agent file as no groups", () => {
    const file = path.join(tmp, "blank.yaml");
    fs.writeFileSync(file, "");
    expect(readAgentGroups(file)).toEqual({});
  });

  it("drops reserved top-level keys when reading", () => {
    const file = path.join(tmp, "reserved.yaml");
    fs.writeFileSync(file, "defaults:\n  timeout: 5\nversion: 1\ng:\n  commands: []\n");
    expect(readAgentGroups(file)).toEqual({ g: { commands: [] } });
  });

  it("reads a missing file as empty and rejects a corrupt one", () => {
    expect(readAgentGroups(path.join(tmp, "nope", "missing.yaml"))).toEqual({});
    const bad = path.join(tmp, "bad.yaml");
    fs.writeFileSync(bad, "a: &anchor b\n");
    expect(() => readAgentGroups(bad)).toThrow(/could not be parsed/);
  });

  it("rethrows non-missing read errors, like a directory path", () => {
    expect(() => readAgentGroups(tmp)).toThrow();
  });

  it("emits a mapping output_to as a flow mapping that round-trips", () => {
    const file = path.join(tmp, "output-to.yaml");
    upsertAgentCommand(
      file,
      "g",
      {},
      { label: "A", command: "echo", output_to: { dir: "logs/", allow_agent: true } },
    );
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("output_to: { dir: logs/, allow_agent: true }");
    expect(readAgentGroups(file).g.commands[0].output_to).toEqual({
      dir: "logs/",
      allow_agent: true,
    });
    upsertAgentCommand(file, "g", {}, { label: "A", command: "echo", output_to: "logs/out.log" });
    expect(readAgentGroups(file).g.commands[0].output_to).toBe("logs/out.log");
  });

  it("writes atomically with owner-only permissions and no leftovers", () => {
    const file = path.join(tmp, "nested", "agent.yaml");
    writeAgentGroups(file, { g: { commands: [{ label: "A", command: "echo" }] } });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["agent.yaml"]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("emits every key shape and tolerates groups without a commands list", () => {
    const file = path.join(tmp, "shapes.yaml");
    fs.writeFileSync(file, "empty:\n  description: nothing here\n");
    const text = emitAgentGroups(readAgentGroups(file));
    expect(text).toContain("empty:");
    expect(text).toContain("commands:");
    upsertAgentCommand(
      file,
      "empty",
      {},
      {
        label: "Full",
        command: "echo hi",
        description: "Every optional key at once",
        args: true,
        timeout: 5,
        cwd: ".",
        pipe: "cat",
        check: { contains: "hi" },
        max_output: 10,
        env_inherit: false,
        nature: "destructive",
      },
    );
    const back = readAgentGroups(file).empty.commands[0];
    expect(back).toMatchObject({
      label: "Full",
      env_inherit: false,
      nature: "destructive",
      check: { contains: "hi" },
      timeout: 5,
    });
    const written = fs.readFileSync(file, "utf8");
    expect(written).toContain("env_inherit: false");
    expect(written).toContain("nature: destructive");
  });

  it("upserts: creates a group, appends and replaces by label", () => {
    const file = path.join(tmp, "upsert.yaml");
    expect(
      upsertAgentCommand(file, "g", { description: "D" }, { label: "A", command: "echo a" }),
    ).toEqual({
      replaced: false,
    });
    expect(upsertAgentCommand(file, "g", {}, { label: "B", command: "echo b" })).toEqual({
      replaced: false,
    });
    expect(
      upsertAgentCommand(file, "g", {}, { label: "A", command: "echo a2", read_only: true }),
    ).toEqual({ replaced: true });
    const groups = readAgentGroups(file);
    expect(groups.g.commands.map((c: any) => c.command)).toEqual(["echo a2", "echo b"]);
    expect(groups.g.description).toBe("D");
    upsertAgentCommand(file, "g2", {}, { label: "D", command: "echo d", destructive: true });
    expect(fs.readFileSync(file, "utf8")).toContain("destructive: true");
  });

  it("refuses an invalid proposal and writes nothing", () => {
    const file = path.join(tmp, "invalid.yaml");
    writeAgentGroups(file, { g: { commands: [{ label: "A", command: "echo" }] } });
    const before = fs.readFileSync(file, "utf8");
    // {file} placeholder with no matching named argument.
    expect(() => upsertAgentCommand(file, "g", {}, { label: "Bad", command: "rm {file}" })).toThrow(
      /placeholder \{file\}/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("validateAgentProposal reports issues without writing", () => {
    const file = path.join(tmp, "validate.yaml");
    writeAgentGroups(file, { g: { commands: [{ label: "A", command: "echo" }] } });
    expect(validateAgentProposal(file, "g", {}, { label: "A", command: "echo ok" })).toEqual([]);
    expect(validateAgentProposal(file, "g", {}, { label: "", command: "echo" })).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("removes commands and emptied groups; false when nothing matches", () => {
    const file = path.join(tmp, "remove.yaml");
    writeAgentGroups(file, {
      g: {
        commands: [
          { label: "A", command: "echo a" },
          { label: "B", command: "echo b" },
        ],
      },
      h: { commands: [{ label: "C", command: "echo c" }] },
    });
    expect(removeAgentCommand(file, "g", "A")).toBe(true);
    expect(removeAgentCommand(file, "g", "A")).toBe(false);
    expect(removeAgentCommand(file, "h", "C")).toBe(true);
    expect(removeAgentCommand(file, "h", "C")).toBe(false);
    expect(removeAgentCommand(file, "nope", "X")).toBe(false);
    expect(readAgentGroups(file)).toEqual({ g: { commands: [{ label: "B", command: "echo b" }] } });
  });

  it("serializes concurrent writes through the lock", async () => {
    const file = path.join(tmp, "locked.yaml");
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withAgentLock(() =>
          upsertAgentCommand(file, "g", {}, { label: `C${i}`, command: `echo ${i}` }),
        ),
      ),
    );
    const names = readAgentGroups(file).g.commands.map((c: any) => c.label);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });
});

describe("agent file discovery and merge", () => {
  it("serves the agent file alone when no human config exists", () => {
    fs.rmSync(agentFile(), { force: true });
    writeAgentGroups(agentFile(), {
      ag: { commands: [{ label: "From agent", command: "echo agent" }] },
    });
    const cfg = loadInTmp();
    expect(cfg.agentPath).toBe(agentFile());
    expect(cfg.paths).toEqual([agentFile()]);
    expect(cfg.groups.ag.commands[0].label).toBe("From agent");
    expect(cfg.issues).toEqual([]);
  });

  it("fills the gaps beneath human configs and reports shadowed agent groups", () => {
    writeAgentGroups(agentFile(), {
      ag: { commands: [{ label: "From agent", command: "echo agent" }] },
      solo: { commands: [{ label: "Survives", command: "echo solo" }] },
    });
    const store = storeFile();
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
      "ag:\n  commands:\n    - label: From store\n      command: echo store\nhum:\n  commands:\n    - label: Human\n      command: echo hum\n",
    );
    const cfg = loadInTmp();
    expect(cfg.agentPath).toBe(agentFile());
    // The human "ag" group wins wholesale; the agent-only group survives.
    expect(cfg.groups.ag.commands[0].label).toBe("From store");
    expect(cfg.groups.solo.commands[0].label).toBe("Survives");
    expect(cfg.issues).toContain(`agent group "ag" is shadowed by a config group of the same name`);
    fs.rmSync(store, { force: true });
  });

  it("treats an unparseable agent file as decisive and names it", () => {
    fs.mkdirSync(path.dirname(agentFile()), { recursive: true });
    fs.writeFileSync(agentFile(), "a: &anchor b\n");
    const cfg = loadInTmp();
    expect(cfg.fatal).toBe(true);
    expect(cfg.issues[0]).toMatch(/agent\.yaml could not be parsed/);
    fs.rmSync(agentFile(), { force: true });
  });

  it("reports an unparseable explicit config as fatal instead of throwing", () => {
    const bad = path.join(tmp, "bad-explicit.yaml");
    fs.writeFileSync(bad, "a: &anchor b\n");
    withEnv({ SHELL_RUNNER_CONFIG: bad, SHELL_RUNNER_HOME: home }, () => {
      const cfg = loadConfig();
      expect(cfg.fatal).toBe(true);
      expect(cfg.issues[0]).toMatch(/bad-explicit\.yaml could not be parsed/);
    });
    fs.rmSync(bad, { force: true });
  });

  it("ignores the agent file entirely when $SHELL_RUNNER_CONFIG is set", () => {
    const explicit = path.join(tmp, "explicit.yaml");
    fs.writeFileSync(explicit, "ex:\n  commands:\n    - label: Explicit\n      command: echo ex\n");
    withEnv({ SHELL_RUNNER_CONFIG: explicit, SHELL_RUNNER_HOME: home }, () => {
      const cfg = loadConfig();
      expect(cfg.explicit).toBe(true);
      expect(cfg.agentPath).toBeUndefined();
      expect(Object.keys(cfg.groups)).toEqual(["ex"]);
      expect(agentConfigPath()).toBeNull();
    });
    fs.rmSync(explicit, { force: true });
  });

  it("keeps the doctor report working when the agent file is unreadable", async () => {
    const { doctorReport } = await import("../../src/report/index.js");
    const bad = path.join(tmp, "bad-agent.yaml");
    fs.writeFileSync(bad, "a: &anchor b\n");
    const report = doctorReport({
      path: bad,
      paths: [bad],
      groups: {},
      defaults: {},
      issues: ["config broken"],
      agentPath: bad,
    });
    expect(report).toContain("Agent file:");
    expect(report).not.toContain("(agent-proposed)");
    fs.rmSync(bad, { force: true });
    // And the no-config-at-all shape still reports where the server looked.
    const missing = doctorReport({
      path: null,
      paths: [],
      groups: {},
      defaults: {},
      issues: ["no config file found"],
    });
    expect(missing).toContain("none found — no commands exposed");
    // And the human-plus-agent shape shows both files on the Config line.
    const both = doctorReport({
      path: "h.yaml",
      paths: ["h.yaml", "agent.yaml"],
      groups: { g: { commands: [{ label: "A", command: "echo" }] } },
      defaults: {},
      issues: [],
      agentPath: "agent.yaml",
    });
    expect(both).toContain("h.yaml + agent.yaml");
  });
});
