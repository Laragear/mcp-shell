import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, projectSlug, storeConfigPath } from "../../src/config/index.js";
import { makeTmp, withEnv, writeConfig } from "../helpers.js";

const tmp = makeTmp("sr-config-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

describe("defaults umbrella without a to", () => {
  it("keeps the truncate-only umbrella intact", () => {
    const prev = process.env.SHELL_RUNNER_CONFIG;
    process.env.SHELL_RUNNER_CONFIG = writeConfig(
      tmp,
      "defaults:\n  output:\n    truncate: 5\ng:\n  commands:\n    - label: A\n      command: echo\n",
    );
    try {
      const cfg = loadConfig();
      expect(cfg.issues).toEqual([]);
      expect(cfg.defaults.output).toEqual({ truncate: 5 });
    } finally {
      if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
      else process.env.SHELL_RUNNER_CONFIG = prev;
    }
  });
});
