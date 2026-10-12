import { describe, expect, it } from "vitest";

describe("spawnStage platform and cancellation corners", () => {
  it("spawns non-detached on win32", async () => {
    const { spawnStage } = await import("../../src/runner/process.js");
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
    const { spawnStage } = await import("../../src/runner/process.js");
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
    const { spawnStage } = await import("../../src/runner/process.js");
    const r = await spawnStage("true", {
      timeoutMs: 5000,
      maxChars: 100,
      stdinChunks: [Buffer.alloc(256 * 1024, 0x78)],
    });
    expect(r.exitCode).toBe(0);
  });

  it("reports spawn errors when the working directory does not exist", async () => {
    const { spawnStage } = await import("../../src/runner/process.js");
    const r = await spawnStage("echo hi", {
      cwd: "/definitely/not/a/dir",
      timeoutMs: 5000,
      maxChars: 100,
    });
    expect(r.spawnError?.message).toContain("ENOENT");
  });
});
