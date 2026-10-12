import { describe, expect, it } from "vitest";
import { effectiveLimits } from "../../src/config/index.js";
import { loadConfigFor, toolsFor } from "../helpers.js";

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
