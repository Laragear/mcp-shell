import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCommandline } from "../../src/tools/index.js";
import { runEntry } from "../../src/runner/index.js";
import { spawnStage } from "../../src/runner/process.js";
import { makeTmp, toolsFor, withEnv } from "../helpers.js";

const tmp = makeTmp("sr-runner-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(configText: string, toolName: string, args?: unknown, agentOutputTo?: unknown) {
  const { tools, cfg } = toolsFor(configText);
  const tool = tools.find((t) => t.schema.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not declared`);
  return runEntry(tool.entry as any, args, cfg.defaults, undefined, agentOutputTo);
}

describe("runEntry output contract", () => {
  it("reports exit code 0 as success, non-zero as error", async () => {
    const ok = await run("g:\n  commands:\n    - label: Ok\n      command: echo hello\n", "g__ok");
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("exit code: 0");
    const failing = await run(
      "g:\n  commands:\n    - label: F\n      command: echo boom >&2; exit 3\n",
      "g__f",
    );
    expect(failing.isError).toBe(true);
    expect(failing.text).toContain("exit code: 3");
  });

  it("keeps the first command's exit code across a parse stage", async () => {
    const parsed = await run(
      "g:\n  commands:\n    - label: P\n      command: printf 'b\\na\\n'\n      pipe: sort | head -1\n",
      "g__p",
    );
    expect(parsed.text).toContain("a");
    const failing = await run(
      "g:\n  commands:\n    - label: P\n      command: echo data; exit 3\n      pipe: cat\n",
      "g__p",
    );
    expect(failing.isError).toBe(true);
    expect(failing.text).toContain("exit code: 3");
  });

  it("prefixes CHECK PASSED/FAILED per the check rules", async () => {
    const pass = await run(
      "g:\n  commands:\n    - label: C\n      command: echo OK\n      check:\n        contains: [OK]\n",
      "g__c",
    );
    expect(pass.text.startsWith("CHECK PASSED.")).toBe(true);
    expect(pass.isError).toBe(false);
    const fail = await run(
      "g:\n  commands:\n    - label: C\n      command: echo nope\n      check:\n        contains: [OK]\n",
      "g__c",
    );
    expect(fail.text.startsWith("CHECK FAILED:")).toBe(true);
    expect(fail.isError).toBe(true);
  });

  it("reports timeouts as timeouts", async () => {
    const r = await run(
      "g:\n  commands:\n    - label: Slow\n      command: sleep 10\n      timeout: 1\n",
      "g__slow",
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Timed out");
  }, 10000);

  it("reports signal death as a signal, not a timeout", async () => {
    const r = await run(
      "g:\n  commands:\n    - label: S\n      command: kill -TERM $$\n      timeout: 10\n",
      "g__s",
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("killed by signal");
    expect(r.text).not.toContain("Timed out");
  });

  it("truncates oversized output instead of dying", async () => {
    const r = await run(
      "g:\n  max_output: 500\n  commands:\n    - label: Chatty\n      command: head -c 5000 /dev/zero | tr '\\0' x\n      timeout: 10\n",
      "g__chatty",
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("truncated");
    expect(r.text).not.toContain("Timed out");
  });

  it("resolves named arguments over the wire", async () => {
    const cfgText = [
      "g:",
      "  commands:",
      "    - label: Greet",
      "      command: echo",
      "      args:",
      "        - name: who",
      "          required: true",
      "        - name: punct",
      "          default: '!'",
    ].join("\n");
    const withDefault = await run(cfgText, "g__greet", { who: "world" });
    expect(withDefault.text).toContain("world !");
    const custom = await run(cfgText, "g__greet", { who: "bob", punct: "?" });
    expect(custom.text).toContain("bob ?");
    const missing = await run(cfgText, "g__greet", {});
    expect(missing.text).toMatch(/Missing required argument "who"/);
    const unknown = await run(cfgText, "g__greet", { who: "x", nope: "y" });
    expect(unknown.text).toMatch(/Unknown argument "nope"/);
  });

  it("never lets a secret argument value surface in results", async () => {
    const r = await run(
      [
        "g:",
        "  commands:",
        "    - label: Secret",
        "      command: test -n",
        "      args:",
        "        - name: token",
        "          required: true",
      ].join("\n"),
      "g__secret",
      { token: "SUPERSECRET123" },
    );
    expect(r.text).not.toContain("SUPERSECRET123");
    expect(r.text).toContain("exit code: 0");
    const missing = await run(
      [
        "g:",
        "  commands:",
        "    - label: Secret",
        "      command: test -n",
        "      args:",
        "        - name: token",
        "          required: true",
      ].join("\n"),
      "g__secret",
      {},
    );
    // The error names the argument, never a value.
    expect(missing.text).toMatch(/Missing required argument "token"/);
  });
});

describe("runEntry file output", () => {
  it("writes raw output files while results keep their shape", async () => {
    const always = await run(
      `g:\n  commands:\n    - label: Always\n      command: echo hello\n      output_to: ${tmp}/out-always.log\n`,
      "g__always",
    );
    expect(fs.readFileSync(path.join(tmp, "out-always.log"), "utf8")).toBe("hello\n");
    expect(always.text).toContain(`output file: ${path.join(tmp, "out-always.log")}`);
    expect(fs.statSync(path.join(tmp, "out-always.log")).mode & 0o777).toBe(0o600);

    // The result truncates at max_output; the file keeps everything.
    const chatty = await run(
      `g:\n  commands:\n    - label: Chatty\n      command: head -c 300 /dev/zero | tr '\\0' x\n      max_output: 100\n      output_to: ${tmp}/out-full.log\n`,
      "g__chatty",
    );
    expect(chatty.text).toContain("truncated");
    expect(fs.readFileSync(path.join(tmp, "out-full.log"), "utf8")).toHaveLength(300);

    // append accumulates across runs.
    await run(
      `g:\n  commands:\n    - label: A\n      command: echo run\n      output_to:\n        path: ${tmp}/out-append.log\n        append: true\n`,
      "g__a",
    );
    await run(
      `g:\n  commands:\n    - label: A\n      command: echo run\n      output_to:\n        path: ${tmp}/out-append.log\n        append: true\n`,
      "g__a",
    );
    expect(
      fs.readFileSync(path.join(tmp, "out-append.log"), "utf8").split("\n").filter(Boolean),
    ).toEqual(["run", "run"]);

    // stderr captured only when asked.
    await run(
      `g:\n  commands:\n    - label: E\n      command: echo out; echo err >&2\n      output_to:\n        path: ${tmp}/out-err.log\n        stderr: true\n`,
      "g__e",
    );
    const errLog = fs.readFileSync(path.join(tmp, "out-err.log"), "utf8");
    expect(errLog).toContain("out");
    expect(errLog).toContain("err");
    await run(
      `g:\n  commands:\n    - label: E\n      command: echo out; echo err >&2\n      output_to: ${tmp}/out-noerr.log\n`,
      "g__e",
    );
    const noErrLog = fs.readFileSync(path.join(tmp, "out-noerr.log"), "utf8");
    expect(noErrLog).toContain("out");
    expect(noErrLog).not.toContain("err");

    // parse shapes the result, never the file.
    const parsed = await run(
      `g:\n  commands:\n    - label: P\n      command: echo rawdata\n      pipe: tail -c 4\n      output_to: ${tmp}/out-parsed.log\n`,
      "g__p",
    );
    expect(parsed.text).toContain("ata");
    expect(fs.readFileSync(path.join(tmp, "out-parsed.log"), "utf8")).toBe("rawdata\n");
  }, 20000);

  it("sandboxes agent-decided output into the configured dir", async () => {
    const agentDir = path.join(tmp, "agentdir");
    const cfg = `g:\n  commands:\n    - label: AgentOk\n      command: printf '{"a":1}'\n      output_to:\n        dir: ${agentDir}\n        allow_agent: true\n`;
    const auto = await run(cfg, "g__agentok", {}, true);
    const written = fs.readdirSync(agentDir);
    expect(written).toHaveLength(1);
    const autoName = written[0];
    expect(autoName).toMatch(/^agentok-\d{8}T\d{6}\.json$/);
    expect(fs.readFileSync(path.join(agentDir, autoName), "utf8")).toBe('{"a":1}');
    expect(auto.text).toMatch(/output file: .*agentok-\d{8}T\d{6}\.json/);

    const _named = await run(cfg, "g__agentok", {}, "report.txt");
    expect(fs.readFileSync(path.join(agentDir, "report.txt"), "utf8")).toBe('{"a":1}');

    // Rejections: no file created, clear errors.
    expect((await run(cfg, "g__agentok", {}, "../evil")).text).toContain(
      "Invalid output_to filename",
    );
    expect((await run(cfg, "g__agentok", {}, "a.b.c")).text).toContain("single optional dot");
    expect((await run(cfg, "g__agentok", {}, "x.exe")).text).toContain('".exe" is not allowed');
    expect(
      (
        await run(
          "g:\n  commands:\n    - label: Plain\n      command: echo hi\n",
          "g__plain",
          {},
          true,
        )
      ).text,
    ).toContain("not enabled");
    expect(fs.readdirSync(agentDir)).toHaveLength(2);
  });

  it("resolves cancellation immediately instead of waiting for the timeout", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Slow\n      command: sleep 30\n      timeout: 20\n",
    );
    const controller = new AbortController();
    const started = Date.now();
    const promise = runEntry(tools[0].entry as any, {}, cfg.defaults, controller.signal);
    setTimeout(() => controller.abort(), 150);
    const r = await promise;
    expect(r.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);
});

describe("runEntry corners", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sr-runcorner-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("fails the run when the command cannot start", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Ok\n      command: echo hi\n      cwd: /definitely/not/a/dir\n",
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Failed to start:");
  });

  it("truncates huge output at max_output and keeps counting the rest", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Seq\n      command: seq 1 100000\n      max_output: 10\n",
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults);
    expect(r.text).toContain("truncated");
    expect(r.text.length).toBeLessThan(500);
  });

  it("reports killed by signal for a command that dies by signal", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Suicidal\n      command: kill -TERM $$\n",
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("killed by signal SIGTERM");
  });

  it("rejects non-boolean non-string agent output_to", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Ok\n      command: echo hi\n      output_to:\n        dir: logs/\n        allow_agent: true\n",
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults, undefined, 5);
    expect(r.text).toContain('output_to must be true or a filename like "report.txt"');
  });

  it("rejects agent filenames outside the strict pattern", async () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: Ok\n      command: echo hi\n      output_to:\n        dir: logs/\n        allow_agent: true\n",
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults, undefined, "bad name!.txt");
    expect(r.text).toContain('Invalid output_to filename "bad name!.txt"');
  });

  it("fails the run when the output file directory cannot be created", async () => {
    // A regular file where the directory should be makes mkdirSync throw.
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    const { tools, cfg } = toolsFor(
      `g:\n  commands:\n    - label: Ok\n      command: echo hi\n      output_to: {path: '${blocker}/out.txt'}\n`,
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults);
    expect(r.text).toContain("Could not write output file");
  });

  it("fails the run when the output file itself cannot be opened", async () => {
    // A directory where the output file would be makes the write stream fail.
    const dir = path.join(tmp, `d${Date.now()}`);
    fs.mkdirSync(path.join(dir, "out.txt"), { recursive: true });
    const { tools, cfg } = toolsFor(
      `g:\n  commands:\n    - label: Ok\n      command: echo hi\n      output_to: {dir: '${dir}', allow_agent: true}\n`,
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults, undefined, "out.txt");
    expect(r.text).toContain("Could not write output file");
  });

  it("teats an agent filename without an extension", async () => {
    const dir = path.join(tmp, `e${Date.now()}`);
    const { tools, cfg } = toolsFor(
      `g:\n  commands:\n    - label: Ok\n      command: echo hi\n      output_to: {dir: '${dir}', allow_agent: true}\n`,
    );
    const r = await runEntry(tools[0].entry, {}, cfg.defaults, undefined, "report");
    expect(r.isError).toBe(false);
    expect(fs.existsSync(path.join(dir, "report.txt"))).toBe(true);
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
});

describe("command behavior through the runner", () => {
  it("quotes every free argument separately, spaces included", async () => {
    const { tools, cfg: c } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: F",
        "      command: printf '[%s]'",
        "      args: true",
      ].join("\n"),
    );
    const r = await runEntry(tools[0].entry, ["a b", "it's"], c.defaults);
    expect(r.text).toContain("[a b][it's]");
  });

  it("appends nothing in free mode when the arguments are not a list", () => {
    const entry = {
      cmd: { command: "echo", label: "X" },
      args: { mode: "free" as const, specs: [] },
    } as any;
    expect(buildCommandline(entry, "a scalar, not a list")).toBe("echo");
    expect(buildCommandline(entry, undefined)).toBe("echo");
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

  it("tolerates an unset HOME with inheritance off", async () => {
    await withEnv({ HOME: undefined }, async () => {
      const { tools, cfg: c } = toolsFor(
        "g:\n  commands:\n    - label: N\n      command: echo ok\n      env_inherit: false\n",
      );
      const r = await runEntry(tools[0].entry, {}, c.defaults);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("ok");
    });
  });

  it("expands env var references in declared env values from the parent environment", async () => {
    const ref = (n: string) => `$\{${n}}`;
    const text = await withEnv({ SR_TOKEN: "s3cret" }, async () => {
      const { tools, cfg: c } = toolsFor(
        [
          "g:",
          "  commands:",
          "    - label: X",
          "      command: echo GOT=$GOT BARE=$SR_TOKEN",
          "      env:",
          `        GOT: "pre-${ref("SR_TOKEN")}-post ${ref("SR_DEFINITELY_NOT_SET")}"`,
        ].join("\n"),
      );
      return (await runEntry(tools[0].entry, {}, c.defaults)).text;
    });
    expect(text).toContain("GOT=pre-s3cret-post");
    // A bare $VAR (no braces) is left to the shell, which finds the parent var.
    expect(text).toContain("BARE=s3cret");
  });

  it("expands an unset env var reference to nothing, also with inheritance off", async () => {
    const unset = "$" + "{SR_DEFINITELY_NOT_SET}";
    const { tools, cfg: c } = toolsFor(
      [
        "g:",
        "  env:",
        `    GONE: '[${unset}]'`,
        "  commands:",
        "    - label: X",
        "      command: echo GONE=$GONE",
        "      env_inherit: false",
      ].join("\n"),
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.text).toContain("GONE=[]");
  });

  it("truncates to the last characters while the output file stays raw", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sr-trunc-")), "logs");
    try {
      const { tools, cfg: c } = toolsFor(
        [
          "g:",
          "  commands:",
          "    - label: T",
          "      command: echo aaaaaa bbbbbb",
          "      output:",
          `        to: {dir: ${dir}}`,
          "        truncate: 7",
        ].join("\n"),
      );
      const r = await runEntry(tools[0].entry, {}, c.defaults);
      expect(r.text).toContain("bbb");
      expect(r.text).toContain("truncated");
      expect(r.text).not.toContain("aaaaaa");
      const [name] = fs.readdirSync(dir);
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      expect(raw).toContain("aaaaaa");
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it("shapes the result by bytes without breaking multibyte characters", async () => {
    const { tools, cfg: c } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: U",
        "      command: echo café café café",
        "      output:",
        "        truncate: {mode: start, bytes: 7}",
      ].join("\n"),
    );
    const r = await runEntry(tools[0].entry, {}, c.defaults);
    expect(r.text).toContain("café c");
    expect(r.text).not.toContain("café café");
    expect(r.text).not.toContain("�");
    expect(r.text).toContain("bytes discarded");
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
});
