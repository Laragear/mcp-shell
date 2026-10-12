import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveTarget } from "../../src/cli.js";
import { projectSlug } from "../../src/config/index.js";
import { parseYaml } from "../../src/yaml/index.js";
import { CDN_SCHEMA_URL, emitConfigTemplate, schemaRef } from "../../src/report/index.js";
import { loadConfigFor, makeTmp, withEnv } from "../helpers.js";

const tmp = makeTmp("sr-report-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const EMPTY = { path: null, paths: [], groups: {}, defaults: {}, issues: [] };

/** A LoadedConfig built by hand, so every report branch is reachable. */
function cfg(
  overrides: Partial<import("../../src/config/index.js").LoadedConfig>,
): import("../../src/config/index.js").LoadedConfig {
  return { ...EMPTY, ...overrides };
}

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
        "mcp-shell",
        "commands.schema.json",
      );
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.writeFileSync(installed, "{}");
      withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => {
        expect(schemaRef()).toBe("./node_modules/@laragear/mcp-shell/commands.schema.json");
      });
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("config template", () => {
  it("round-trips a loaded config through the emitted template", () => {
    const cfg = loadConfigFor(
      [
        "web:",
        "  description: Web app tasks",
        "  trigger: on request",
        "  env:",
        "    NODE_ENV: test",
        "  commands:",
        "    - label: Test all",
        "      command: npm test 2>&1 | tail -20",
        "      args: true",
        "      check:",
        "        not_contains: [FAIL]",
        "    - label: Lint",
        "      command: npx eslint --fix",
        "      args:",
        "        - name: file",
        "          description: File to lint",
        "          required: true",
        "        - name: max-warnings",
        "          default: '0'",
        "      read_only: true",
        "      pipe: wc -l",
      ].join("\n"),
    );
    const text = emitConfigTemplate(cfg);
    // The emitted template must itself be valid config YAML…
    const g = parseYaml(text).web;
    expect(g.description).toBe("Web app tasks");
    expect(g.env).toEqual({ NODE_ENV: "test" });
    expect(g.commands).toHaveLength(2);
    expect(g.commands[0].command).toBe("npm test 2>&1 | tail -20");
    expect(g.commands[0].args).toBe(true);
    expect(g.commands[0].check).toEqual({ not_contains: ["FAIL"] });
    expect(
      g.commands[1].args.map((a: any) => ({
        name: a.name,
        required: !!a.required,
        default: a.default,
      })),
    ).toEqual([
      { name: "file", required: true, default: undefined },
      { name: "max-warnings", required: false, default: "0" },
    ]);
    // …and a starter template from an empty config must parse too.
    const starter = parseYaml(
      emitConfigTemplate({ path: null, paths: [], groups: {}, defaults: {}, issues: [] }),
    );
    expect(starter.myproject.commands.length).toBeGreaterThanOrEqual(1);
    expect(starter.myproject.commands[0].label).toBe("Run all tests");
  });

  it("resolves the CLI save targets", () => {
    const projDir = makeTmp("sr-save-");
    const userDir = makeTmp("sr-home-");
    try {
      withEnv({ SHELL_RUNNER_PROJECT_DIR: projDir, SHELL_RUNNER_HOME: userDir }, () => {
        expect(saveTarget("agents")).toBe(
          path.join(userDir, ".agents", "mcp-shell", projectSlug(), "commands.yaml"),
        );
        expect(saveTarget("user")).toBe(path.join(userDir, ".agents", "shell-runner.yaml"));
        expect(saveTarget("bogus")).toBeNull();
      });
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  });
});

it("skips non-object groups when assembling the template", () => {
  const text = emitConfigTemplate(cfg({ groups: { bad: null, g: { commands: [] } } as any }));
  expect(text).toContain("g:");
  expect(text).not.toContain("bad:");
  expect(emitConfigTemplate(cfg({ groups: undefined }))).toContain("myproject:");
});
