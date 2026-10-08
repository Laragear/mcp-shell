import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { emitConfigTemplate } from "../src/report/index.js";
import { saveTarget } from "../src/cli.js";
import { projectSlug } from "../src/config/index.js";
import * as path from "node:path";
import { parseYaml } from "../src/yaml/index.js";
import { loadConfigFor, makeTmp, withEnv } from "./helpers.js";

const tmp = makeTmp("sr-report-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
          path.join(userDir, ".agents", "mcp-shell-runner", projectSlug(), "commands.yaml"),
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
