import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { doctorReport, emitConfigTemplate } from "../src/report/index.js";
import { emitGroupTemplate } from "../src/report/group.js";
import { emitCommand } from "../src/report/yaml.js";
import { validateConfig } from "../src/config/validate.js";
import type { LoadedConfig } from "../src/config/index.js";
import { buildCommandline, flattenTools, previewCommandline } from "../src/tools/index.js";
import { requestSignal } from "../src/server/middleware.js";
import { runEntry } from "../src/runner/index.js";
import { spawnStage } from "../src/runner/process.js";
import { killRunningChildren, trackRunningChild } from "../src/runner/kill.js";
import { parseYaml } from "../src/yaml/index.js";
import { makeTmp, toolsFor, withEnv } from "./helpers.js";

/** A hand-built LoadedConfig for report tests. */
function cfg(overrides: Partial<LoadedConfig>): LoadedConfig {
  return { path: null, paths: [], groups: {}, defaults: {}, issues: [], ...overrides };
}

describe("validateConfig corners", () => {
  it("tolerates a null group map", () => {
    expect(validateConfig(null as any)).toEqual({ issues: [], validGroups: 0 });
  });
});

describe("doctor report corners", () => {
  it("renders group output_to alone and skips a blank parse stage", () => {
    const report = doctorReport(
      cfg({
        paths: ["cfg.yaml"],
        groups: {
          g: {
            output_to: "logs/",
            commands: [{ label: "A", command: "echo", pipe: "   " }],
          },
        },
      }),
    );
    expect(report).toContain('Group settings: output_to="logs/"');
    expect(report).not.toContain("parse:");
  });

  it("renders group timeout and cwd without output_to, and scalar check values", () => {
    const report = doctorReport(
      cfg({
        paths: ["cfg.yaml"],
        groups: {
          g: {
            timeout: 5,
            cwd: "./x",
            commands: [{ label: "A", command: "echo", check: { contains: "ok" } }],
          },
        },
      }),
    );
    expect(report).toContain("Group settings: timeout=5s, cwd=./x");
    expect(report).not.toContain("output_to=");
    expect(report).toContain('check: contains=["ok"]');
  });

  it("tolerates a null group map", () => {
    expect(doctorReport(cfg({ groups: null as any }))).toContain("Built-in tools:");
  });
});

describe("report corners", () => {
  it("skips non-object groups when assembling the template", () => {
    const text = emitConfigTemplate(cfg({ groups: { bad: null, g: { commands: [] } } as any }));
    expect(text).toContain("g:");
    expect(text).not.toContain("bad:");
    expect(emitConfigTemplate(cfg({ groups: undefined }))).toContain("myproject:");
  });

  it("emits an empty group with the starter command", () => {
    const text = emitGroupTemplate("g", {}).join("\n");
    expect(text).toContain("command: npm test");
    expect(text).not.toContain("# timeout: undefined");
  });

  it("emits fallbacks for a command without label or command", () => {
    const out: string[] = [];
    emitCommand(out, {});
    const text = out.join("\n");
    expect(text).toContain("label: New command");
    expect(text).toContain("command: echo fill-me-in");
  });

  it("emits the read_only and destructive hints as configured", () => {
    const text = emitGroupTemplate("g", {
      commands: [{ label: "A", command: "echo", read_only: true, destructive: true }],
    }).join("\n");
    expect(text).toContain("# read_only: true");
    expect(text).toContain("# destructive: true");
  });
});

describe("tools corners", () => {
  it("handles placeholders without a declared argument", () => {
    const entry = {
      cmd: { command: "echo {gone}", label: "X" },
      args: { mode: "named" as const, specs: [{ name: "other", required: true }] },
    } as any;
    expect(previewCommandline(entry)).toContain("{gone}");
    expect(buildCommandline(entry, { other: "x" })).toEqual({
      error: 'Placeholder "{gone}" has no matching named argument.',
    });
  });

  it("treats non-object named arguments as no values", () => {
    const entry = {
      cmd: { command: "echo {a}", label: "X" },
      args: { mode: "named" as const, specs: [{ name: "a", required: true }] },
    } as any;
    expect(buildCommandline(entry, "scalar")).toEqual({
      error: 'Missing required argument "a".',
    });
  });

  it("describes multiple placeholders with the plural", () => {
    const multi = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: M",
        "      command: cp {src} {dst}",
        "      args:",
        "        - name: src",
        "          required: true",
        "        - name: dst",
        "          required: true",
      ].join("\n"),
    ).tools[0];
    expect(multi.schema.description).toContain("placeholders in the command line");
  });

  it("runs with group and command environment variables", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sr-env-")), "logs");
    const { tools, cfg: c } = toolsFor(
      [
        "g:",
        "  env:",
        "    GROUP_VAR: from-group",
        "  commands:",
        "    - label: E",
        "      command: echo $GROUP_VAR $CMD_VAR",
        "      env:",
        "        CMD_VAR: from-command",
        "      output_to:",
        `        dir: ${dir}`,
        "        allow_agent: true",
      ].join("\n"),
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults, undefined, true);
    expect(r.text).toContain("from-group from-command");
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
  });

  it("stops parent env inheritance with env_inherit: false", async () => {
    const { tools, cfg: c } = withEnv({ SR_PARENT_ONLY: "42" }, () =>
      toolsFor(
        [
          "g:",
          "  commands:",
          "    - label: N",
          '      command: echo MINE=$SR_MINE PARENT=$SR_PARENT_ONLY PATH=$([ -n "$PATH" ] && echo set)',
          "      env:",
          "        SR_MINE: mine",
          "      env_inherit: false",
        ].join("\n"),
      ),
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.text).toContain("MINE=mine");
    expect(r.text).toContain("PATH=set");
    expect(r.text).toContain("PARENT=");
    expect(r.text).not.toContain("PARENT=42");
  });

  it("keeps PATH and HOME when inheritance is off without declared env", async () => {
    const { tools, cfg: c } = toolsFor(
      "g:\n  commands:\n    - label: N\n      command: printenv PATH\n      env_inherit: false\n",
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.isError).toBe(false);
  });

  it("resolves env_inherit through command, group and defaults precedence", async () => {
    const config = (groupKey: string, cmdKey: string, defaults: string) =>
      toolsFor(
        [
          ...(defaults ? [`defaults:`, `  ${defaults}`] : []),
          "g:",
          `  ${groupKey}`,
          "  commands:",
          "    - label: N",
          "      command: echo PARENT=$SR_PARENT_ONLY",
          `      ${cmdKey}`,
        ].join("\n"),
      );
    const run = async (t: ReturnType<typeof toolsFor>) => {
      const r = await runEntry(t.tools[0].entry, {}, t.cfg.defaults);
      return r.text;
    };
    // Command true overrides a group false.
    const both = config("env_inherit: false", "env_inherit: true", "");
    await withEnv({ SR_PARENT_ONLY: "42" }, async () => {
      expect(await run(both)).toContain("PARENT=42");
    });
    // Defaults false, nothing nearer: no inheritance.
    const defaultsOnly = config("", "", "env_inherit: false");
    await withEnv({ SR_PARENT_ONLY: "42" }, async () => {
      expect(await run(defaultsOnly)).not.toContain("PARENT=42");
    });
    // Group true overrides defaults false.
    const groupWins = config("env_inherit: true", "", "env_inherit: false");
    await withEnv({ SR_PARENT_ONLY: "42" }, async () => {
      expect(await run(groupWins)).toContain("PARENT=42");
    });
  });

  it("ignores blank descriptions and mentions file output only when the agent may opt in", () => {
    const blank = flattenTools({
      g: { commands: [{ label: "A", command: "echo", description: "  " }] },
    }).find((t) => !("builtin" in t.entry));
    if (!blank) throw new Error("no declared tool generated");
    expect(blank.schema.title).toBe("A");

    const fixed = toolsFor(
      "g:\n  commands:\n    - label: A\n      command: echo\n      output_to: out.txt\n",
    ).tools[0];
    expect(fixed.schema.description).not.toContain("You may pass output_to");
  });
});

describe("server corners", () => {
  it("returns no signal for a request id without a controller", () => {
    const ghost = { getContext: () => ({ requestId: "ghost" }) };
    expect(requestSignal(ghost as any)).toBeUndefined();
    const anonymous = { getContext: () => ({ requestId: undefined }) };
    expect(requestSignal(anonymous as any)).toBeUndefined();
  });
});

describe("runner corners", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-corner-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("resolves cwd through group, command and environment precedence", async () => {
    const groupDir = makeTmp("sr-cwd-group-");
    const envDir = makeTmp("sr-cwd-env-");
    try {
      const { tools, cfg: c } = toolsFor(
        `g:\n  cwd: ${groupDir}\n  commands:\n    - label: P\n      command: pwd\n`,
      );
      const r = await runEntry(tools[0].entry, {}, c.defaults);
      expect(r.text).toContain(path.basename(groupDir));

      const { tools: t2, cfg: c2 } = toolsFor(
        "g:\n  commands:\n    - label: P\n      command: pwd\n",
      );
      const r2 = await withEnv({ SHELL_RUNNER_CWD: envDir }, () =>
        runEntry(t2[0].entry, {}, c2.defaults),
      );
      expect(r2.text).toContain(path.basename(envDir));
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
      fs.rmSync(envDir, { recursive: true, force: true });
    }
  });

  it("reports cancellation for a signal aborted before the spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await spawnStage("sleep 5", {
      timeoutMs: 30000,
      maxChars: 100,
      signal: controller.signal,
    });
    expect(r.cancelled).toBe(true);

    const { tools, cfg: c } = toolsFor(
      "g:\n  commands:\n    - label: S\n      command: sleep 5\n      timeout: 20\n",
    );
    const r2 = await runEntry(tools[0].entry, {}, c.defaults, controller.signal);
    expect(r2.cancelled).toBe(true);
  }, 10000);

  it("cancels a run when the signal aborted between stages", async () => {
    const { tools, cfg: c } = toolsFor(
      "g:\n  commands:\n    - label: P\n      command: echo hi\n      pipe: tail -1\n      timeout: 20\n",
    );
    const controller = new AbortController();
    const run = runEntry(tools[0].entry, {}, c.defaults, controller.signal);
    // The command finishes immediately; aborting afterwards still cancels
    // the run through the post-stage signal checks.
    controller.abort();
    const r = await run;
    expect(r.cancelled).toBe(true);
  });

  it("does not run checks on a timed-out command", async () => {
    const { tools, cfg: c } = toolsFor(
      "g:\n  commands:\n    - label: Slow\n      command: sleep 2\n      timeout: 1\n      check: {contains: [done]}\n",
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Timed out after 1s");
    expect(r.text).not.toContain("CHECK FAILED");
  }, 10000);

  it("reports signal death with a teed output file", async () => {
    const dir = path.join(tmp, `sig${Date.now()}`);
    const { tools, cfg: c } = toolsFor(
      `g:\n  commands:\n    - label: S\n      command: echo printed; kill -TERM $$\n      output_to: {dir: '${dir}'}\n`,
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.text).toContain("killed by signal SIGTERM");
    expect(r.text).toContain("output file:");
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
  });

  it("keeps counting discarded tee chunks after a write failure", async () => {
    const blocker = path.join(tmp, "blocker2");
    fs.writeFileSync(blocker, "not a dir");
    const { tools, cfg: c } = toolsFor(
      `g:\n  commands:\n    - label: S\n      command: seq 1 100000\n      max_output: 10\n      output_to: {path: '${blocker}/out.txt'}\n`,
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.text).toContain("Could not write output file");
  });

  it("ignores children without a pid and tolerates killing failures", () => {
    const noPid = { kill: vi.fn(), on: vi.fn() };
    trackRunningChild(noPid as any);
    const throwing = {
      pid: 4194305,
      kill: vi.fn(() => {
        throw new Error("gone");
      }),
      on: vi.fn(),
    };
    trackRunningChild(throwing as any);
    expect(() => killRunningChildren()).not.toThrow();
    expect(throwing.kill).toHaveBeenCalled();
  });

  it("uses child.kill when the group kill fails on win32", () => {
    const win32 = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const kill = vi.fn(() => {
        throw new Error("nope");
      });
      trackRunningChild({ pid: process.pid, kill, on: vi.fn() } as any);
      expect(() => killRunningChildren()).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", win32 as number);
    }
  });
});

describe("yaml parser corners", () => {
  it("parses null-ish scalars and an empty flow value", () => {
    expect(parseYamlRaw("a: ~")).toEqual({ a: null });
    expect(parseYamlRaw("a: {x: }")).toEqual({ a: { x: null } });
  });

  it("parses a value-less key at the end of the document", () => {
    expect(parseYamlRaw("a:\n")).toEqual({ a: null });
  });

  it("rejects anchors and aliases", () => {
    expect(() => parseYamlRaw("a: &x 1")).toThrow(/anchors\/aliases/);
    expect(() => parseYamlRaw("a: *x")).toThrow(/anchors\/aliases/);
  });

  it("handles an empty block scalar body followed by a dedent", () => {
    expect(parseYamlRaw("t: |\na: 1")).toEqual({ t: "", a: 1 });
  });

  it("supports folded keep chomping", () => {
    expect(parseYamlRaw("t: >+\n  a\n")).toEqual({ t: "a\n\n" });
  });

  it("keeps blank lines between mappings and rejects non-string keys", () => {
    expect(parseYamlRaw("a: 1\n\nb: 2")).toEqual({ a: 1, b: 2 });
    expect(() => parseYamlRaw("1: x")).toThrow("mapping key must be a string");
  });

  it("parses a null value before a dedented key", () => {
    expect(parseYamlRaw("a:\nb: 1")).toEqual({ a: null, b: 1 });
  });
});

/** parseYaml with a short local alias. */
function parseYamlRaw(text: string): any {
  return parseYaml(text);
}
