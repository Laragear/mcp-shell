import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { emitGroupTemplate } from "../src/report/group.js";
import {
  CDN_SCHEMA_URL,
  doctorReport,
  emitConfigTemplate,
  schemaRef,
} from "../src/report/index.js";
import { yamlScalar } from "../src/report/yaml.js";
import { loadConfigFor, makeTmp, withEnv } from "./helpers.js";

const EMPTY = { path: null, paths: [], groups: {}, defaults: {}, issues: [] };

describe("yamlScalar", () => {
  it("quotes values that are not plain YAML scalars", () => {
    expect(yamlScalar("plain")).toBe("plain");
    expect(yamlScalar("has: colon")).toBe("'has: colon'");
    expect(yamlScalar("")).toBe("''");
    expect(yamlScalar("42")).toBe("'42'");
    expect(yamlScalar("true")).toBe("'true'");
    expect(yamlScalar(" padded ")).toBe("' padded '");
    expect(yamlScalar("it's")).toBe("'it''s'");
  });
});

describe("emitGroupTemplate", () => {
  it("emits group settings and the starter command for an empty group", () => {
    const lines = emitGroupTemplate("mygroup", { timeout: 30, cwd: "./x" });
    const text = lines.join("\n");
    expect(text).toContain("mygroup:");
    expect(text).toContain("# timeout: '30'   # seconds, group-wide default");
    expect(text).toContain("# cwd: ./x   # group-wide default working directory");
    expect(text).toContain("# env:");
    expect(text).toContain("command: npm test");
    expect(text).toContain("Full reference of optional command keys:");
  });

  it("emits declared commands and a real env mapping", () => {
    const lines = emitGroupTemplate("g", {
      env: { CI: "true" },
      commands: [
        {
          label: "Build",
          command: "make {target}",
          args: [{ name: "target", required: true, prefix: "--target ", suffix: ":rw" }],
          description: "Build it",
          timeout: 9,
          cwd: "./sub",
          env: { CI: "true" },
          pipe: "tail -1",
          check: { contains: ["ok"], regex: "\\d" },
          max_output: 500,
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("  env:");
    expect(text).toContain("CI: 'true'");
    expect(text).toContain("label: Build");
    expect(text).toContain("command: 'make {target}'");
    expect(text).toContain("- name: target");
    expect(text).toContain("prefix: '--target '");
    expect(text).toContain("suffix: ':rw'");
    expect(text).toContain("description: Build it");
    expect(text).toContain("label: Build");
    expect(text).toContain("timeout: '9'");
    expect(text).toContain("cwd: ./sub");
    expect(text).toContain("pipe: tail -1");
    expect(text).toContain("check:");
    expect(text).toContain("contains: [ok]");
    expect(text).toContain("regex: \\d");
    expect(text).toContain("max_output: '500'");
    expect(text).not.toContain("Full reference");
  });

  it("emits the args-free and args-absent variants", () => {
    const free = emitGroupTemplate("g", {
      commands: [{ label: "A", command: "echo", args: true }],
    });
    expect(free.join("\n")).toContain("args: true");
    const none = emitGroupTemplate("g", { commands: [{ label: "A", command: "echo" }] });
    expect(none.join("\n")).toContain("# args: false");
  });
});

describe("emitConfigTemplate", () => {
  it("renders one section per group, separated by a blank line", () => {
    const cfg = loadConfigFor(
      "g1:\n  commands:\n    - label: A\n      command: echo\ng2:\n  commands:\n    - label: B\n      command: echo\n",
    );
    const text = emitConfigTemplate(cfg);
    expect(text).toContain("# yaml-language-server: $schema=");
    expect(text).toContain("g1:");
    expect(text).toContain("g2:");
  });

  it("renders the starter group when no config is loaded", () => {
    const text = emitConfigTemplate({
      path: null,
      paths: [],
      groups: {},
      defaults: {},
      issues: [],
    });
    expect(text).toContain("myproject:");
    expect(text).toContain("# defaults:");
  });
});

/** Loads the config currently pointed at by $SHELL_RUNNER_CONFIG. */
describe("doctor extras", () => {
  it("renders a group with no description or trigger", () => {
    const report = doctorReport({
      path: null,
      paths: ["x"],
      groups: { g: { commands: [{ label: "A", command: "echo" }] } },
      defaults: {},
      issues: [],
    });
    expect(report).toContain("## g");
    expect(report).not.toContain("Group settings:");
  });
});

describe("schemaRef", () => {
  it("points the $schema line at the most portable reference available", () => {
    const proj = makeTmp("sr-schemaref-");
    try {
      // Nothing local: the pinned CDN copy.
      withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => {
        expect(schemaRef()).toBe(CDN_SCHEMA_URL);
        expect(emitConfigTemplate(EMPTY).split("\n")[0]).toContain(CDN_SCHEMA_URL);
      });
      // A schema dumped next to the config beats the CDN.
      fs.mkdirSync(path.join(proj, ".agents"), { recursive: true });
      fs.writeFileSync(path.join(proj, ".agents", "commands.schema.json"), "{}");
      withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => {
        expect(schemaRef()).toBe(".agents/commands.schema.json");
      });
      // A project-local install beats both.
      const installed = path.join(
        proj,
        "node_modules",
        "@laragear",
        "mcp-shell-runner",
        "commands.schema.json",
      );
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.writeFileSync(installed, "{}");
      withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => {
        expect(schemaRef()).toBe("./node_modules/@laragear/mcp-shell-runner/commands.schema.json");
      });
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
