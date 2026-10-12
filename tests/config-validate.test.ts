import { loadConfig, normalizeOutputTo, validateConfig } from "../src/config/index.js";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfigFor, withEnv } from "./helpers.js";

/** The issues reported for a config text, through the real load path. */
function issuesFor(text: string): string[] {
  return loadConfigFor(text).issues;
}

/** Writes a config file and loads it through $SHELL_RUNNER_CONFIG. */
function loadFile(name: string, text: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-cfgfmt-"));
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  try {
    return withEnv({ SHELL_RUNNER_CONFIG: p }, () => loadConfig());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("config validation messages", () => {
  it("reports every invalid check spec", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      check: 5",
        "    - label: B",
        "      command: echo",
        "      check: {bogus: x}",
        "    - label: C",
        "      command: echo",
        "      check: {regex: '['}",
        "    - label: D",
        "      command: echo",
        "      check: {not_regex: ['[', '(']}",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('"check" must be a mapping'))).toBe(true);
    expect(issues.some((i) => i.includes('unknown check rule "bogus"'))).toBe(true);
    expect(issues.filter((i) => i.includes("invalid regex")).length).toBeGreaterThan(0);
    expect(issues.filter((i) => i.includes("invalid not_regex")).length).toBeGreaterThan(0);
  });

  it("accepts a compiling regex and non-regex check rules", () => {
    const { issues } = validateConfig({
      g: {
        commands: [
          {
            label: "Ok",
            command: "echo",
            check: { contains: "done", regex: "passed \\d+ tests" },
          },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it("reports a non-string argument prefix or suffix", () => {
    const { issues } = validateConfig({
      g: {
        commands: [
          {
            label: "Bad",
            command: "echo",
            args: [{ name: "mem", prefix: 5, suffix: true }],
          },
        ],
      },
    });
    expect(issues.some((i: string) => i.includes('"prefix" must be a string'))).toBe(true);
    expect(issues.some((i: string) => i.includes('"suffix" must be a string'))).toBe(true);
  });

  it("reports every invalid args declaration", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      args: yes-please",
        "    - label: B",
        "      command: echo",
        "      args:",
        "        - description: no name",
        "    - label: C",
        "      command: echo",
        "      args:",
        "        - name: '  '",
        "    - label: D",
        "      command: echo",
        "      args:",
        "        - name: dup",
        "        - name: dup",
        "    - label: E",
        "      command: echo {file}",
        "      args: true",
        "    - label: F",
        "      command: echo {file}",
        "    - label: G",
        "      command: echo {file}",
        "      args:",
        "        - name: other",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('"args" must be true, false, or a list'))).toBe(true);
    expect(
      issues.filter((i) => i.includes('every entry in "args" needs a non-empty "name"')).length,
    ).toBe(2);
    expect(issues.some((i) => i.includes('duplicate argument name "dup"'))).toBe(true);
    expect(issues.some((i) => i.includes('"args: true" is ambiguous'))).toBe(true);
    expect(issues.some((i) => i.includes("declares no named arguments"))).toBe(true);
    expect(
      issues.some((i) => i.includes("placeholder {file} has no matching named argument")),
    ).toBe(true);
  });

  it("reports invalid command fields", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      timeout: 0",
        "      cwd: 5",
        "      env: [1]",
        "      env_inherit: nope",
        "      pipe: '  '",
        "    - 5",
        "    - name: ''",
        "    - label: B",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('"timeout" must be a positive number'))).toBe(true);
    expect(issues.some((i) => i.includes('"cwd" must be a string'))).toBe(true);
    expect(issues.some((i) => i.includes('"env" must be a mapping'))).toBe(true);
    expect(issues.some((i) => i.includes('"env_inherit" must be true or false'))).toBe(true);
    expect(issues.some((i) => i.includes('"pipe" must be a non-empty command string'))).toBe(true);
    expect(issues.some((i) => i.includes(": must be a mapping"))).toBe(true);
    expect(issues.some((i) => i.includes('missing non-empty "label"'))).toBe(true);
    expect(issues.some((i) => i.includes('missing non-empty "command"'))).toBe(true);
  });

  it("reports invalid group fields", () => {
    const issues = issuesFor(
      [
        "g1: 5",
        "g2:",
        "  description: no commands list",
        "g3:",
        "  commands: []",
        "  timeout: nope",
        "  cwd: 7",
        "  env: nope",
        "  env_inherit: 3",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('group "g1": must be a mapping'))).toBe(true);
    expect(issues.some((i) => i.includes('group "g2": missing "commands" list'))).toBe(true);
    expect(issues.filter((i) => i.includes('"timeout" must be a positive number')).length).toBe(1);
    expect(issues.some((i) => i.includes('"cwd" must be a string'))).toBe(true);
    expect(issues.some((i) => i.includes('"env" must be a mapping'))).toBe(true);
    expect(issues.some((i) => i.includes('"env_inherit" must be true or false'))).toBe(true);
  });
});

describe("read_only and destructive validation", () => {
  it("rejects non-boolean flags", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      read_only: 1",
        "      destructive: nope",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.includes('"read_only" must be true or false'))).toHaveLength(1);
    expect(issues.filter((i) => i.includes('"destructive" must be true or false'))).toHaveLength(1);
  });

  it("rejects both flags at once", () => {
    const issues = issuesFor(
      "g:\n  commands:\n    - label: A\n      command: echo\n      read_only: true\n      destructive: true\n",
    );
    expect(
      issues.some((i) => i.includes('"read_only" and "destructive" cannot both be true')),
    ).toBe(true);
  });

  it("rejects side-effecting keys on a read_only command", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: cat f.txt",
        "      read_only: true",
        "      env: { A: 1 }",
        "      pipe: wc -l",
        "      output_to: out.txt",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('cannot declare "env"'))).toBe(true);
    expect(issues.some((i) => i.includes('cannot declare "pipe"'))).toBe(true);
    expect(issues.some((i) => i.includes('cannot declare "output_to"'))).toBe(true);
  });

  it("allows output_to: false on a read_only command", () => {
    const issues = issuesFor(
      "g:\n  commands:\n    - label: A\n      command: cat f.txt\n      read_only: true\n      output_to: false\n",
    );
    expect(issues.some((i) => i.includes('cannot declare "output_to"'))).toBe(false);
  });
});

describe("output umbrella validation", () => {
  it("rejects non-mapping and unknown keys", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output: nope",
        "    - label: B",
        "      command: echo",
        "      output: {to: a.log, mystery: 1}",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('"output" must be a mapping'))).toBe(true);
    expect(issues.some((i) => i.includes('"output" has an unknown key "mystery"'))).toBe(true);
  });

  it("rejects alias keys declared twice on the same level", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output: {pipe: tail -1, to: a.log}",
        "      pipe: head -1",
        "      output_to: b.log",
      ].join("\n"),
    );
    expect(issues.some((i) => i.includes('"output" "pipe" and "pipe" are the same thing'))).toBe(
      true,
    );
    expect(issues.some((i) => i.includes('"output" "to" and "output_to" are the same thing'))).toBe(
      true,
    );
  });

  it("validates the pipe and to sub-keys", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output:",
        "        pipe: '  '",
        "        to: {path: x, dir: y}",
      ].join("\n"),
    );
    expect(
      issues.some((i) => i.includes('"output" "pipe" must be a non-empty command string')),
    ).toBe(true);
    expect(
      issues.some((i) => i.includes('"output" "to": "output_to" accepts "path" or "dir"')),
    ).toBe(true);
  });

  it("accepts the umbrella on groups and commands without conflicts", () => {
    const issues = issuesFor(
      [
        "g:",
        "  output:",
        "    to: {dir: logs/, allow_agent: true}",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output:",
        "        pipe: tail -1",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
  });

  it("validates the truncate sub-key forms", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output:",
        "        truncate: 0",
        "    - label: B",
        "      command: echo",
        "      output:",
        "        truncate: nope",
        "    - label: C",
        "      command: echo",
        "      output:",
        "        truncate: {mode: middle, length: 5}",
        "    - label: D",
        "      command: echo",
        "      output:",
        "        truncate: {length: 5, bytes: 10}",
        "    - label: E",
        "      command: echo",
        "      output:",
        "        truncate: {mode: start}",
        "    - label: F",
        "      command: echo",
        "      output:",
        "        truncate: {length: -1}",
      ].join("\n"),
    );
    expect(issues.filter((i) => i.includes('"truncate" must be a positive number'))).toHaveLength(
      2,
    );
    expect(
      issues.some((i) => i.includes('"truncate" must be a positive number or a mapping')),
    ).toBe(true);
    expect(issues.some((i) => i.includes('"truncate" "mode" must be "start" or "end"'))).toBe(true);
    expect(issues.some((i) => i.includes("not both"))).toBe(true);
    expect(
      issues.some((i) => i.includes('needs a positive "length" (characters) or "bytes"')),
    ).toBe(true);
    expect(issues.some((i) => i.includes('"length" must be a positive number'))).toBe(true);
  });

  it("accepts every valid truncate form", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output:",
        "        truncate: 500",
        "    - label: B",
        "      command: echo",
        "      output:",
        "        truncate: {mode: start, length: 10}",
        "    - label: C",
        "      command: echo",
        "      output:",
        "        truncate: {bytes: 4096}",
      ].join("\n"),
    );
    expect(issues).toEqual([]);
  });
});

describe("output_to validation", () => {
  it("reports every invalid output_to form", () => {
    const issues = issuesFor(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      output_to: {path: a.txt, dir: logs/}",
        "    - label: B",
        "      command: echo",
        "      output_to: {}",
        "    - label: C",
        "      command: echo",
        "      output_to: {path: a.txt, allow_agent: 'yes'}",
        "    - label: D",
        "      command: echo",
        "      output_to: {path: a.txt, allow_agent: true}",
        "    - label: E",
        "      command: echo",
        "      output_to: {path: a.txt, append: 'x'}",
        "    - label: E2",
        "      command: echo",
        "      output_to: {path: a.txt, stderr: 'y'}",
        "    - label: F",
        "      command: echo",
        "      output_to: ''",
        "    - label: G",
        "      command: echo",
        "      output_to: 5",
        "    - label: H",
        "      command: echo",
        "      output_to: [1]",
        "    - label: I",
        "      command: echo",
        "      output_to: 'logs/{file}.txt'",
      ].join("\n"),
    );
    const all = issues.join("\n");
    expect(all).toContain('accepts "path" or "dir", not both');
    expect(all).toContain('mapping needs a non-empty "path" or "dir"');
    expect(all).toContain('"output_to.allow_agent" must be a boolean');
    expect(all).toContain('"output_to" with "allow_agent: true" needs a "dir"');
    expect(all).toContain('"output_to.append" must be a boolean');
    expect(all).toContain('"output_to.stderr" must be a boolean');
    expect(all).toContain("must be a non-empty path string or a mapping");
    expect(all).toContain("must be false, a path string, or a mapping");
    expect(all).toContain("placeholder {file} is not supported");
  });

  it("accepts the {group} placeholder and normalizes booleans", () => {
    const out = normalizeOutputTo("t", { dir: "logs/{group}/", allow_agent: true }, []);
    expect(out).toMatchObject({
      dir: "logs/{group}/",
      allow_agent: true,
      append: false,
      stderr: false,
      path: null,
    });
  });

  it("reports invalid defaults output_to and empty configs", () => {
    const issues = issuesFor("defaults:\n  output_to: 42\n");
    expect(issues.join("\n")).toContain('config "defaults" "output_to"');
  });

  it("reports a config that declares no commands at all", () => {
    const issues = issuesFor("defaults:\n  timeout: 5\n");
    expect(issues).toContain("config declares no commands");
  });

  it("parses JSON config files by name and by content sniffing", () => {
    const byName = loadFile("cfg.json", '{"g": {"commands": [{"label": "A", "command": "echo"}]}}');
    expect(byName.issues).toHaveLength(0);
    expect(byName.groups.g.commands).toHaveLength(1);
    const byContent = loadFile(
      "cfg.yaml",
      '{"g": {"commands": [{"label": "A", "command": "echo"}]}}',
    );
    expect(byContent.issues).toHaveLength(0);
    const jsonNull = loadFile("cfg3.json", "null");
    expect(jsonNull.issues).toContain("config declares no commands");
  });
});
