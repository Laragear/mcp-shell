import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runCli } from "../src/cli.js";
import { storeConfigPath } from "../src/config/index.js";
import { mergeIo } from "../src/cli.js";
import { makeTmp, withEnv } from "./helpers.js";

// The untouched terminal I/O, before any test replaces it via answer().
const realPrompt = mergeIo.prompt;
const realReadLine = mergeIo.readLine;

const tmp = makeTmp("sr-cli-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let logged: string[] = [];
let errored: string[] = [];

beforeEach(() => {
  logged = [];
  errored = [];
  vi.spyOn(console, "log").mockImplementation((m: string) => logged.push(m));
  vi.spyOn(console, "error").mockImplementation((m: string) => errored.push(m));
});

function cfgFile(text: string): string {
  const p = path.join(tmp, `cli-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(p, text);
  return p;
}

describe("runCli --validate", () => {
  it("exits 0 with the doctor report for a valid config", () => {
    const cfg = cfgFile("g:\n  commands:\n    - label: Ok\n      command: echo hi\n");
    expect(
      withEnv({ SHELL_RUNNER_VALIDATE: "1", SHELL_RUNNER_CONFIG: cfg }, () => runCli([])),
    ).toBe(0);
    expect(logged.join("\n")).toContain(`Config: ${cfg}`);
    expect(logged.join("\n")).toContain("g__ok");
  });

  it("exits 1 and reports the issues for an invalid config", () => {
    const cfg = cfgFile("g:\n  commands:\n    - command: echo\n");
    expect(withEnv({ SHELL_RUNNER_CONFIG: cfg }, () => runCli(["--validate"]))).toBe(1);
    expect(logged.join("\n")).toContain("Config issues (1)");
  });

  it("points --validate at an explicit config path", () => {
    const cfg = cfgFile("g:\n  commands:\n    - label: Ok\n      command: echo\n");
    expect(withEnv({}, () => runCli(["--validate", cfg]))).toBe(0);
    expect(logged.join("\n")).toContain(`Config: ${cfg}`);
  });

  it("keeps the explicit path when it is the only argument", () => {
    const cfg = cfgFile("g:\n  commands:\n    - label: Ok\n      command: echo\n");
    expect(withEnv({}, () => runCli(["--validate", cfg, "--extra"]))).toBe(0);
  });

  it("prints the bundled schema with --schema", () => {
    expect(withEnv({ SHELL_RUNNER_PROJECT_DIR: tmp }, () => runCli(["--schema"]))).toBe(0);
    const schema = JSON.parse(logged.join("\n"));
    expect(schema.$id).toBe("shell-runner-commands-schema");
  });

  it("saves the schema next to the config and refuses to overwrite without --force", () => {
    const proj = makeTmp("sr-schema-cli-");
    try {
      const save = () =>
        withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => runCli(["--schema", "--save", "agents"]));
      expect(save()).toBe(0);
      const target = path.join(proj, ".agents", "commands.schema.json");
      expect(JSON.parse(fs.readFileSync(target, "utf8")).$id).toBe("shell-runner-commands-schema");
      // Second save refuses without --force.
      expect(save()).toBe(1);
      expect(errored.join("\n")).toContain("already exists");
      expect(
        withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () =>
          runCli(["--schema", "--save", "agents", "--force"]),
        ),
      ).toBe(0);
      // Only "agents" is a valid schema target.
      expect(
        withEnv({ SHELL_RUNNER_PROJECT_DIR: proj }, () => runCli(["--schema", "--save", "user"])),
      ).toBe(1);
      expect(errored.join("\n")).toContain('use "agents"');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it("returns -1 for a non-CLI invocation", () => {
    expect(withEnv({}, () => runCli([]))).toBe(-1);
    expect(withEnv({ SHELL_RUNNER_VALIDATE: undefined }, () => runCli(["serve"]))).toBe(-1);
  });
});

describe("runCli --template", () => {
  it("prints the template of the config at an explicit path", () => {
    const cfg = cfgFile("g:\n  commands:\n    - label: Ok\n      command: echo\n");
    expect(withEnv({}, () => runCli(["--template", cfg]))).toBe(0);
    expect(logged.join("\n")).toContain("g:");
  });

  it("ignores extra positional arguments beyond the config path", () => {
    const cfg = cfgFile("g:\n  commands:\n    - label: Ok\n      command: echo\n");
    expect(withEnv({}, () => runCli(["--template", cfg, "--extra"]))).toBe(0);
  });

  it("saves the template to the trusted store of the project", () => {
    const proj = makeTmp("sr-cli-proj-");
    const home = makeTmp("sr-cli-home-");
    try {
      const code = withEnv({ SHELL_RUNNER_PROJECT_DIR: proj, SHELL_RUNNER_HOME: home }, () =>
        runCli(["--template", "--save", "agents"]),
      );
      expect(code).toBe(0);
      const target = withEnv({ SHELL_RUNNER_PROJECT_DIR: proj, SHELL_RUNNER_HOME: home }, () =>
        storeConfigPath(),
      );
      expect(fs.readFileSync(target, "utf8")).toContain("myproject:");
      expect(logged.join("\n")).toContain(`Template written to ${target}`);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("saves the template to the user .agents directory", () => {
    const home = makeTmp("sr-cli-home-");
    try {
      const code = withEnv({ SHELL_RUNNER_HOME: home }, () =>
        runCli(["--template", "--save", "user"]),
      );
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(home, ".agents", "shell-runner.yaml"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing target without --force", () => {
    const home = makeTmp("sr-cli-home2-");
    try {
      withEnv({ SHELL_RUNNER_HOME: home }, () => runCli(["--template", "--save", "user"]));
      const second = withEnv({ SHELL_RUNNER_HOME: home }, () =>
        runCli(["--template", "--save", "user"]),
      );
      expect(second).toBe(1);
      expect(errored.join("\n")).toContain("pass --force to replace it");
      expect(
        withEnv({ SHELL_RUNNER_HOME: home }, () =>
          runCli(["--template", "--save", "user", "--force"]),
        ),
      ).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects an unknown save target", () => {
    expect(withEnv({}, () => runCli(["--template", "--save", "bogus"]))).toBe(1);
    expect(errored.join("\n")).toContain('Unknown save target "bogus"');
  });

  it("fails cleanly when the save target cannot be created", () => {
    // A file where the directory should be makes mkdirSync throw.
    const home = makeTmp("sr-cli-home3-");
    fs.writeFileSync(path.join(home, ".agents"), "not a directory");
    try {
      expect(
        withEnv({ SHELL_RUNNER_HOME: home }, () => runCli(["--template", "--save", "user"])),
      ).toBe(1);
      expect(errored.join("\n")).toContain("Save failed:");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runCli --merge", () => {
  let proj: string;
  let home: string;

  beforeEach(() => {
    proj = makeTmp("sr-merge-proj-");
    home = makeTmp("sr-merge-home-");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function env(): Record<string, string | undefined> {
    return {
      SHELL_RUNNER_PROJECT_DIR: proj,
      SHELL_RUNNER_HOME: home,
      SHELL_RUNNER_CONFIG: undefined,
    };
  }

  function proposal(text: string): void {
    fs.mkdirSync(path.join(proj, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".agents", "shell-runner.yaml"), text);
  }

  function answer(line: string): void {
    mergeIo.readLine = () => line;
    mergeIo.prompt = () => {};
  }

  function storeText(): string {
    return withEnv(env(), () => fs.readFileSync(storeConfigPath(), "utf8"));
  }

  it("refuses when $SHELL_RUNNER_CONFIG is set", () => {
    expect(
      withEnv({ SHELL_RUNNER_CONFIG: path.join(tmp, "x.yaml") }, () => runCli(["--merge"])),
    ).toBe(1);
    expect(errored.join("\n")).toContain("nothing to merge");
  });

  it("reports when there is no proposal", () => {
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(1);
    expect(errored.join("\n")).toContain("No project config proposal");
  });

  it("reports an unparseable proposal without writing", () => {
    proposal("a: &anchor b\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(1);
    expect(errored.join("\n")).toContain("could not be parsed");
    expect(withEnv(env(), () => fs.existsSync(storeConfigPath()))).toBe(false);
  });

  it("merges new and conflicting groups after a yes", () => {
    proposal("fresh:\n  commands:\n    - label: New\n      command: echo new\n");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(
        storeConfigPath(),
        "fresh:\n  commands:\n    - label: Old\n      command: echo old\n",
      );
    });
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(0);
    const text = storeText();
    expect(text).toContain("echo new");
    expect(text).not.toContain("echo old");
    expect(logged.join("\n")).toContain(`Merged into ${withEnv(env(), () => storeConfigPath())}`);
    expect(logged.join("\n")).toContain("Conflicting groups");
  });

  it("keeps the store defaults across the merge", () => {
    proposal("g:\n  commands:\n    - label: A\n      command: echo\n");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(storeConfigPath(), "defaults:\n  timeout: 42\ng:\n  commands: []\n");
    });
    answer("yes\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(0);
    expect(storeText()).toContain("timeout: 42");
  });

  it("aborts without writing on anything but a yes", () => {
    proposal("g:\n  commands:\n    - label: A\n      command: echo\n");
    answer("n\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(1);
    expect(logged.join("\n")).toContain("nothing was written");
    expect(withEnv(env(), () => fs.existsSync(storeConfigPath()))).toBe(false);
  });

  it("refuses a merge that would produce an invalid config", () => {
    proposal("g:\n  commands:\n    - command: echo\n");
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(1);
    expect(errored.join("\n")).toContain("invalid config");
    expect(withEnv(env(), () => fs.existsSync(storeConfigPath()))).toBe(false);
  });

  it("reports an unparseable store without writing", () => {
    proposal("g:\n  commands:\n    - label: A\n      command: echo\n");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(storeConfigPath(), "a: &anchor b\n");
    });
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(1);
    expect(errored.join("\n")).toContain("could not be parsed");
    expect(withEnv(env(), () => fs.existsSync(storeConfigPath()))).toBe(true);
  });

  it("merges an empty proposal into an existing store", () => {
    proposal("");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(
        storeConfigPath(),
        "g:\n  commands:\n    - label: Old\n      command: echo\n",
      );
    });
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(0);
  });

  it("merges into an empty store file", () => {
    proposal("g:\n  commands:\n    - label: A\n      command: echo\n");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(storeConfigPath(), "");
    });
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(0);
    expect(storeText()).toContain("label: A");
  });

  it("drops a store default that is not a mapping", () => {
    proposal("g:\n  commands:\n    - label: A\n      command: echo\n");
    withEnv(env(), () => {
      fs.mkdirSync(path.dirname(storeConfigPath()), { recursive: true });
      fs.writeFileSync(storeConfigPath(), "defaults: 42\ng:\n  commands: []\n");
    });
    answer("y\n");
    expect(withEnv(env(), () => runCli(["--merge"]))).toBe(0);
    expect(storeText()).not.toContain("defaults");
  });

  it("the default merge I/O writes the prompt and reads stdin", () => {
    mergeIo.prompt = realPrompt;
    mergeIo.readLine = realReadLine;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Stdin blocks forever in a test worker, so fd 0 is pointed at a file
    // holding the answer: closing it makes the next open reclaim fd 0.
    const stdinFile = path.join(tmp, "stdin-answer.txt");
    fs.writeFileSync(stdinFile, "y\n");
    const realStdinFd = 0;
    fs.closeSync(realStdinFd);
    const replacement = fs.openSync(stdinFile, "r");
    try {
      expect(replacement).toBe(realStdinFd);
      mergeIo.prompt("Merge? [y/N] ");
      expect(out).toHaveBeenCalledWith("Merge? [y/N] ");
      expect(mergeIo.readLine()).toBe("y\n");
    } finally {
      vi.restoreAllMocks();
      fs.closeSync(replacement);
      fs.openSync("/dev/null", "r"); // leave a readable fd 0 behind
    }
  });
});
