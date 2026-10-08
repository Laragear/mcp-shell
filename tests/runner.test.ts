import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { matchOutput, runEntry } from "../src/runner/index.js";
import { makeTmp, toolsFor } from "./helpers.js";

const tmp = makeTmp("sr-runner-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(configText: string, toolName: string, args?: unknown, agentOutputTo?: unknown) {
  const { tools, cfg } = toolsFor(configText);
  const tool = tools.find((t) => t.schema.name === toolName);
  if (!tool) throw new Error(`tool ${toolName} not declared`);
  return runEntry(tool.entry as any, args, cfg.defaults, undefined, agentOutputTo);
}

describe("matchOutput", () => {
  it("applies contains/not_contains/regex/not_regex with AND semantics", () => {
    expect(matchOutput("all 12 tests passed", { contains: "passed" })).toEqual({
      ok: true,
      reasons: [],
    });
    const r = matchOutput("3 FAILURES", { not_contains: ["FAILURES"], regex: ["\\d+ passed"] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
    expect(matchOutput("ok", { regex: ["[unclosed"] } as any).ok).toBe(false);
    expect(matchOutput("x", {})).toEqual({ ok: true, reasons: [] });
  });
});

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
