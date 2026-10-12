import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchOutput } from "../src/runner/index.js";
import { makeCollector } from "../src/runner/capture.js";
import { killRunningChildren, trackRunningChild } from "../src/runner/kill.js";
import { runEntry } from "../src/runner/index.js";
import { toolsFor } from "./helpers.js";

describe("matchOutput", () => {
  it("checks contains and not_contains in scalar and list form", () => {
    expect(matchOutput("all good", { contains: "good" })).toEqual({ ok: true, reasons: [] });
    expect(matchOutput("all good", { contains: ["good", "great"] }).ok).toBe(false);
    expect(matchOutput("all good", { contains: "great" }).reasons).toEqual([
      'does not contain "great"',
    ]);
    expect(matchOutput("has FAIL here", { not_contains: "FAIL" }).reasons).toEqual([
      'contains forbidden "FAIL"',
    ]);
    expect(matchOutput("clean", { not_contains: ["nope", "nada"] })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("checks regex and not_regex, reporting invalid patterns", () => {
    expect(matchOutput("12 passed", { regex: "\\d+ passed" })).toEqual({ ok: true, reasons: [] });
    expect(matchOutput("nothing", { regex: "\\d+" }).reasons[0]).toContain("does not match regex");
    expect(matchOutput("12 passed", { not_regex: "passed" }).reasons[0]).toContain(
      "matches forbidden regex",
    );
    expect(matchOutput("clean", { not_regex: "zzz" }).ok).toBe(true);
    expect(matchOutput("x", { regex: "[" }).reasons[0]).toContain("invalid regex");
    expect(matchOutput("x", { not_regex: "(" }).reasons[0]).toContain("invalid not_regex");
  });
});

describe("makeCollector", () => {
  it("keeps counting discarded characters after the cap", () => {
    const c = makeCollector({ kind: "default", mode: "start", limit: 5 });
    c.push(Buffer.from("12345"));
    c.push(Buffer.from("67890"));
    c.push(Buffer.from("extra"));
    expect(c.text()).toBe("12345\n…[truncated, 10 more characters discarded]");
  });

  it("keeps the last characters with mode end", () => {
    const c = makeCollector({ kind: "chars", mode: "end", limit: 5 });
    c.push(Buffer.from("12345"));
    c.push(Buffer.from("67890"));
    c.push(Buffer.from("extra"));
    expect(c.text()).toBe("extra\n…[truncated, 10 more characters discarded]");
  });

  it("keeps the first bytes and never cuts a multibyte character", () => {
    const c = makeCollector({ kind: "bytes", mode: "start", limit: 4 });
    c.push(Buffer.from("ééé", "utf8"));
    expect(c.text()).toBe("éé\n…[truncated, 2 more bytes discarded]");
  });

  it("keeps the last bytes and never cuts a multibyte character", () => {
    const c = makeCollector({ kind: "bytes", mode: "end", limit: 4 });
    c.push(Buffer.from("ááá", "utf8"));
    expect(c.text()).toBe("áá\n…[truncated, 2 more bytes discarded]");
  });

  it("keeps everything when the limit is larger than the output", () => {
    const c = makeCollector({ kind: "chars", mode: "end", limit: 100 });
    c.push(Buffer.from("small"));
    expect(c.text()).toBe("small");
    const b = makeCollector({ kind: "bytes", mode: "end", limit: 100 });
    b.push(Buffer.from("small"));
    expect(b.text()).toBe("small");
  });

  it("stops keeping raw chunks past the byte cap", () => {
    const c = makeCollector({ kind: "default", mode: "start", limit: 100 });
    c.push(Buffer.alloc(8 * 1024 * 1024, 0x61));
    c.push(Buffer.from("more"));
    expect(c.chunks()).toHaveLength(1);
    expect(c.text()).toContain("more");
  });
});

describe("killRunningChildren", () => {
  it("falls back to child.kill when the process group is gone", () => {
    const kill = vi.fn();
    const on = vi.fn();
    trackRunningChild({ pid: 4194304, kill, on } as any);
    killRunningChildren();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses child.kill directly on win32", () => {
    const win32 = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const kill = vi.fn();
      const on = vi.fn();
      trackRunningChild({ pid: process.pid, kill, on } as any);
      killRunningChildren();
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      Object.defineProperty(process, "platform", win32 as number);
    }
  });
});

describe("spawnStage platform and cancellation corners", () => {
  it("spawns non-detached on win32", async () => {
    const { spawnStage } = await import("../src/runner/process.js");
    const win32 = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const r = await spawnStage("echo hi", { timeoutMs: 5000, maxChars: 100 });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
    } finally {
      Object.defineProperty(process, "platform", win32 as number);
    }
  });

  it("hard-kills a child that ignores SIGTERM after the grace period", async () => {
    const { spawnStage } = await import("../src/runner/process.js");
    const controller = new AbortController();
    const started = Date.now();
    const run = spawnStage("trap '' TERM; sleep 5", {
      timeoutMs: 30000,
      maxChars: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10000);

  it("swallows a stdin write error when the child exits without reading", async () => {
    const { spawnStage } = await import("../src/runner/process.js");
    const r = await spawnStage("true", {
      timeoutMs: 5000,
      maxChars: 100,
      stdinChunks: [Buffer.alloc(256 * 1024, 0x78)],
    });
    expect(r.exitCode).toBe(0);
  });

  it("reports spawn errors when the working directory does not exist", async () => {
    const { spawnStage } = await import("../src/runner/process.js");
    const r = await spawnStage("echo hi", {
      cwd: "/definitely/not/a/dir",
      timeoutMs: 5000,
      maxChars: 100,
    });
    expect(r.spawnError?.message).toContain("ENOENT");
  });
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
