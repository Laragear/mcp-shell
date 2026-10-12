import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveLimits, loadConfig, projectSlug, storeConfigPath } from "../src/config/index.js";
import { flattenTools } from "../src/tools/index.js";
import {
  type DeclaredTool,
  loadConfigFor,
  makeTmp,
  toolsFor,
  withEnv,
  writeConfig,
} from "./helpers.js";

const tmp = makeTmp("sr-config-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("validation", () => {
  it("reports missing label/command/commands instead of silently skipping", () => {
    const { issues } = loadConfigFor(
      `group:\n  commands:\n    - command: echo hi\n    - label: NoCmd\n`,
    );
    expect(issues.some((i) => /missing non-empty "label"/.test(i))).toBe(true);
    expect(issues.some((i) => /missing non-empty "command"/.test(i))).toBe(true);
  });

  it("reports bad check rules and invalid regexes", () => {
    const { issues } = loadConfigFor(
      `g:\n  commands:\n    - label: X\n      command: echo\n      check:\n        wat: [a]\n        regex: ['[unclosed']\n`,
    );
    expect(issues.some((i) => /unknown check rule "wat"/.test(i))).toBe(true);
    expect(issues.some((i) => /invalid regex/.test(i))).toBe(true);
  });

  it("reports placeholder/args mismatches", () => {
    const ok = loadConfigFor(
      "g:\n  commands:\n    - label: P\n      command: git checkout {branch}\n      args:\n        - name: branch\n          required: true\n",
    );
    expect(ok.issues).toEqual([]);
    const missing = loadConfigFor(
      "g:\n  commands:\n    - label: P\n      command: git checkout {branch}\n",
    );
    expect(
      missing.issues.some((i) => /placeholder \{branch\} but declares no named arguments/.test(i)),
    ).toBe(true);
    const free = loadConfigFor(
      "g:\n  commands:\n    - label: P\n      command: git checkout {branch}\n      args: true\n",
    );
    expect(free.issues.some((i) => /args: true" is ambiguous/.test(i))).toBe(true);
  });

  it("accepts a valid config and flags an empty one", () => {
    expect(loadConfigFor("g:\n  commands:\n    - label: A\n      command: echo\n").issues).toEqual(
      [],
    );
    const empty = loadConfigFor("g:\n  description: nothing here\n");
    expect(empty.issues.some((i) => /no commands/.test(i))).toBe(true);
  });
});

describe("output_to validation and precedence", () => {
  it("reports every malformed shape with its location", () => {
    const bad = loadConfigFor(
      [
        "g:",
        "  output_to:",
        "    path: a.log",
        "    dir: logs/",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output_to: true",
        "    - label: B",
        "      command: echo",
        "      output_to:",
        "        allow_agent: true",
        "    - label: B2",
        "      command: echo",
        "      output_to:",
        "        path: b.log",
        "        allow_agent: true",
        "    - label: C",
        "      command: echo",
        "      output_to:",
        "        dir: logs/",
        "        allow_agent: true",
        "        append: maybe",
        "    - label: D",
        "      command: echo",
        "      output_to: logs/{secret}.log",
      ].join("\n"),
    );
    const j = bad.issues.join("|");
    expect(j).toContain('"output_to" accepts "path" or "dir", not both');
    expect(j).toContain('"output_to" must be false, a path string, or a mapping');
    expect(j).toContain('mapping needs a non-empty "path" or "dir"');
    expect(j).toContain('with "allow_agent: true" needs a "dir"');
    expect(j).toContain('"output_to.append" must be a boolean');
    expect(j).toContain("placeholder {secret} is not supported");
  });

  it("accepts the valid shapes at every level", () => {
    const ok = loadConfigFor(
      [
        "defaults:",
        "  output_to: logs/{group}/{command}.log",
        "g:",
        "  output_to:",
        "    dir: logs/",
        "    allow_agent: true",
        "    stderr: true",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output_to: false",
      ].join("\n"),
    );
    expect(ok.issues).toEqual([]);
  });

  it("resolves nearest definition wholesale", () => {
    const off = effectiveLimits(
      { output_to: false },
      { output_to: "group.log" },
      { output_to: "def.log" },
    );
    expect(off.outputTo).toBeNull();
    const cmd = effectiveLimits({ output_to: "cmd.log" }, {}, { output_to: "def.log" });
    expect(cmd.outputTo?.path).toBe("cmd.log");
    const group = effectiveLimits(
      {},
      { output_to: { dir: "l/", allow_agent: true, stderr: true } },
      {},
    );
    expect(group.outputTo?.allow_agent).toBe(true);
    expect(group.outputTo?.stderr).toBe(true);
    const def = effectiveLimits({}, {}, { output_to: "def.log" });
    expect(def.outputTo?.path).toBe("def.log");
    expect(effectiveLimits({}, {}, {}).outputTo).toBeNull();
  });

  it("resolves the output umbrella identically to the top-level aliases", () => {
    // The load path coalesces output.* into the top-level keys.
    const { tools, cfg } = toolsFor(
      [
        "defaults:",
        "  output:",
        "    to: def.log",
        "g:",
        "  output:",
        "    to:",
        "      dir: logs/",
        "      allow_agent: true",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "    - label: B",
        "      command: echo",
        "      output:",
        "        to: cmd.log",
        "        pipe: tail -1",
      ].join("\n"),
    );
    expect(cfg.issues).toEqual([]);
    const group = cfg.groups.g;
    const byLabel = (label: string) => tools.find((t) => t.entry.cmd.label === label);
    const a = byLabel("A");
    expect(a?.schema.description).toContain("output_to (true");
    expect(effectiveLimits(a?.entry.cmd, group, cfg.defaults).outputTo?.dir).toBe("logs/");
    const b = byLabel("B");
    expect(b?.entry.cmd.pipe).toBe("tail -1");
    expect(effectiveLimits(b?.entry.cmd, group, cfg.defaults).outputTo?.path).toBe("cmd.log");
    // Defaults were coalesced too.
    expect(cfg.defaults.output_to).toBe("def.log");
    expect(cfg.defaults.output).toBeUndefined();
  });

  it("keeps the nearest definition when umbrella and alias forms mix across levels", () => {
    const { tools, cfg } = toolsFor(
      [
        "g:",
        "  output:",
        "    pipe: tail -1",
        "    to: group.log",
        "  commands:",
        "    - label: A",
        "      command: echo hi",
        "      output_to: false",
        "    - label: B",
        "      command: echo hi | wc -c",
        "      pipe: cat",
      ].join("\n"),
    );
    expect(cfg.issues).toEqual([]);
    const group = cfg.groups.g;
    const a = tools.find((t) => t.entry.cmd.label === "A");
    // The group umbrella becomes the effective group pipe; the command
    // output_to: false still wins wholesale over the group to.
    expect((group as any).pipe).toBe("tail -1");
    expect(a?.entry.cmd.pipe).toBeUndefined();
    expect(effectiveLimits(a?.entry.cmd, group, cfg.defaults).outputTo).toBeNull();
    const b = tools.find((t) => t.entry.cmd.label === "B");
    expect(b?.entry.cmd.pipe).toBe("cat");
  });

  it("resolves output.truncate through command, group and defaults", () => {
    // Numeric shorthand keeps the last characters.
    expect(effectiveLimits({ output: { truncate: 500 } }, {}, {})).toMatchObject({
      truncate: { kind: "chars", mode: "end", limit: 500 },
    });
    // The nearest output block wins as a whole.
    const mixed = effectiveLimits(
      {},
      { output: { truncate: { mode: "start", length: 10 } } },
      { output: { truncate: { bytes: 4096 } } },
    );
    expect(mixed.truncate).toEqual({ kind: "chars", mode: "start", limit: 10 });
    const byDefault = effectiveLimits({}, {}, { output: { truncate: { bytes: 4096 } } });
    expect(byDefault.truncate).toEqual({ kind: "bytes", mode: "end", limit: 4096 });
    // Invalid forms fall back to the default shape (already reported).
    expect(effectiveLimits({ output: { truncate: 0 } }, {}, {})).toMatchObject({
      truncate: { kind: "default", mode: "start" },
    });
    expect(effectiveLimits({}, {}, {}).truncate).toEqual({
      kind: "default",
      mode: "start",
      limit: 20000,
    });
  });
});

describe("discovery and merge", () => {
  it("uses $SHELL_RUNNER_CONFIG alone when set", () => {
    const projDir = makeTmp("sr-proj-");
    const userDir = makeTmp("sr-home-");
    fs.mkdirSync(path.join(projDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".agents", "shell-runner.yaml"),
      "fromproject:\n  commands:\n    - label: A\n      command: echo\n",
    );
    fs.mkdirSync(path.join(userDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, ".agents", "shell-runner.yaml"),
      "fromhome:\n  commands:\n    - label: B\n      command: echo\n",
    );
    try {
      withEnv(
        {
          SHELL_RUNNER_PROJECT_DIR: projDir,
          SHELL_RUNNER_HOME: userDir,
          SHELL_RUNNER_CONFIG: writeConfig(
            tmp,
            "fromenv:\n  commands:\n    - label: C\n      command: echo\n",
          ),
        },
        () => {
          const cfg = loadConfig();
          expect(cfg.paths).toHaveLength(1);
          expect(cfg.groups.fromenv).toBeTruthy();
          expect(cfg.groups.fromproject).toBeUndefined();
          expect(cfg.groups.fromhome).toBeUndefined();
        },
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("merges user-global config per group with store precedence", () => {
    const projDir = makeTmp("sr-proj-");
    const userDir = makeTmp("sr-home-");
    fs.mkdirSync(path.join(userDir, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, ".agents", "shell-runner.yaml"),
      [
        "defaults:",
        "  timeout: 99",
        "  max_output: 1234",
        "shared:",
        "  commands:",
        "    - label: From home",
        "      command: echo home",
        "onlyhome:",
        "  commands:",
        "    - label: H",
        "      command: echo h",
      ].join("\n"),
    );
    try {
      withEnv(
        {
          SHELL_RUNNER_PROJECT_DIR: projDir,
          SHELL_RUNNER_HOME: userDir,
          SHELL_RUNNER_CONFIG: undefined,
        },
        () => {
          const store = storeConfigPath();
          fs.mkdirSync(path.dirname(store), { recursive: true });
          fs.writeFileSync(
            store,
            [
              "defaults:",
              "  timeout: 30",
              "shared:",
              "  commands:",
              "    - label: From store",
              "      command: echo store",
              "onlystore:",
              "  commands:",
              "    - label: P",
              "      command: echo p",
            ].join("\n"),
          );
          const cfg = loadConfig();
          expect(cfg.paths).toHaveLength(2);
          expect(cfg.groups.shared.commands[0].label).toBe("From store");
          expect(cfg.groups.onlyhome).toBeTruthy();
          expect(cfg.groups.onlystore).toBeTruthy();
          expect(cfg.defaults.timeout).toBe(30);
          expect(cfg.defaults.max_output).toBe(1234);
          expect(cfg.issues).toEqual([]);
        },
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("never loads a project config file; it becomes a proposal", () => {
    const projDir = makeTmp("sr-proj-");
    const userDir = makeTmp("sr-home-");
    fs.mkdirSync(path.join(projDir, ".agents"), { recursive: true });
    const proposal = path.join(projDir, ".agents", "shell-runner.yaml");
    fs.writeFileSync(proposal, "fromproject:\n  commands:\n    - label: A\n      command: echo\n");
    try {
      withEnv(
        {
          SHELL_RUNNER_PROJECT_DIR: projDir,
          SHELL_RUNNER_HOME: userDir,
          SHELL_RUNNER_CONFIG: undefined,
        },
        () => {
          const cfg = loadConfig();
          expect(cfg.paths).toHaveLength(0);
          expect(cfg.groups.fromproject).toBeUndefined();
          expect(cfg.proposalPath).toBe(proposal);
        },
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("slugs distinct project dirs apart even when their stems collapse", () => {
    withEnv({ SHELL_RUNNER_PROJECT_DIR: "/x/a-b", SHELL_RUNNER_CONFIG: undefined }, () => {
      const first = projectSlug();
      expect(first).toMatch(/-x-a-b-[0-9a-f]{8}$/);
      withEnv({ SHELL_RUNNER_PROJECT_DIR: "/x/a/b" }, () => {
        const second = projectSlug();
        // Both compact to the same stem; the hash suffix tells them apart.
        expect(second.startsWith(first.split("-").slice(0, -1).join("-"))).toBe(true);
        expect(second).not.toBe(first);
      });
    });
  });

  it("treats a parse error as decisive and names the file", () => {
    const projDir = makeTmp("sr-proj-");
    const userDir = makeTmp("sr-home-");
    try {
      withEnv(
        {
          SHELL_RUNNER_PROJECT_DIR: projDir,
          SHELL_RUNNER_HOME: userDir,
          SHELL_RUNNER_CONFIG: undefined,
        },
        () => {
          const store = storeConfigPath();
          fs.mkdirSync(path.dirname(store), { recursive: true });
          fs.writeFileSync(store, "g:\n  commands:\n oops\n");
          const cfg = loadConfig();
          expect(cfg.fatal).toBeTruthy();
          expect(cfg.issues[0]).toMatch(/could not be parsed/);
          expect(cfg.issues[0]).toContain(store);
        },
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });

  it("lists the searched locations when no config exists", () => {
    const projDir = makeTmp("sr-proj-");
    const userDir = makeTmp("sr-home-");
    try {
      withEnv(
        {
          SHELL_RUNNER_PROJECT_DIR: projDir,
          SHELL_RUNNER_HOME: userDir,
          SHELL_RUNNER_CONFIG: path.join(tmp, "missing.yaml"),
        },
        () => {
          const cfg = loadConfig();
          expect(cfg.path).toBeNull();
          expect(cfg.issues.some((i) => /no config file found/.test(i))).toBe(true);
          expect(cfg.issues.some((i) => /\.agents\/shell-runner/.test(i))).toBe(true);
        },
      );
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });
});

describe("effective limits precedence", () => {
  it("resolves command > group > defaults > env > built-in", () => {
    const cfg = loadConfigFor(
      [
        "defaults:",
        "  timeout: 10",
        "  max_output: 1000",
        "g:",
        "  timeout: 20",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "    - label: B",
        "      command: echo",
        "      timeout: 30",
        "      max_output: 500",
      ].join("\n"),
    );
    const tools = flattenTools(cfg.groups, cfg.defaults).filter(
      (t): t is DeclaredTool => !("builtin" in t.entry),
    );
    const [a, b] = tools;
    expect(effectiveLimits(a.entry.cmd, a.entry.group, cfg.defaults).timeoutSec).toBe(20);
    expect(effectiveLimits(b.entry.cmd, b.entry.group, cfg.defaults).timeoutSec).toBe(30);
    expect(effectiveLimits(b.entry.cmd, b.entry.group, cfg.defaults).maxChars).toBe(500);
    expect(effectiveLimits({}, { timeout: 20 }, { timeout: 10 }).timeoutSec).toBe(20);
    expect(effectiveLimits({}, {}, { timeout: 10 }).timeoutSec).toBe(10);
  });
});
