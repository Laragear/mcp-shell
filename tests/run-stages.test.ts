import { afterEach, describe, expect, it, vi } from "vitest";
import { toolsFor } from "./helpers.js";

// The orchestration paths that a real /bin/sh spawn cannot reach
// deterministically: spawn errors in either stage.
const spawnStage = vi.fn();
vi.mock("../src/runner/process.js", () => ({
  spawnStage: (...args: unknown[]) => spawnStage(...args),
}));

import { runEntry } from "../src/runner/index.js";

const { tools, cfg } = toolsFor(
  "g:\n  commands:\n    - label: Piped\n      command: echo hi\n      pipe: tail -1\n",
);
const entry = tools[0].entry;

afterEach(() => {
  spawnStage.mockReset();
});

describe("runEntry with failing spawns", () => {
  it("reports a first-stage spawn error", async () => {
    spawnStage.mockResolvedValue({
      spawnError: new Error("E2BIG"),
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: "",
    });
    const r = await runEntry(entry, {}, cfg.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Failed to start: E2BIG");
  });

  it("reports a parse-stage spawn error without changing the exit code", async () => {
    spawnStage
      .mockResolvedValueOnce({
        exitCode: 3,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "warned",
        rawChunks: [],
      })
      .mockResolvedValueOnce({
        spawnError: new Error("ENOENT"),
        timedOut: false,
        cancelled: false,
        stdout: "",
        stderr: "",
      });
    const r = await runEntry(entry, {}, cfg.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("exit code: 3");
    expect(r.text).toContain("parse failed to start: ENOENT");
    expect(r.text).toContain("warned");
  });

  it("propagates a parse-stage cancellation", async () => {
    spawnStage
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "",
        rawChunks: [],
      })
      .mockResolvedValueOnce({
        exitCode: null,
        timedOut: false,
        cancelled: true,
        stdout: "",
        stderr: "",
      });
    const r = await runEntry(entry, {}, cfg.defaults);
    expect(r.cancelled).toBe(true);
    expect(r.text).toBe("Cancelled by client.");
  });

  it("reports a parse-stage timeout with its stage label", async () => {
    spawnStage
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "",
        rawChunks: [],
      })
      .mockResolvedValueOnce({
        exitCode: null,
        timedOut: true,
        cancelled: false,
        stdout: "partial",
        stderr: "",
      });
    const r = await runEntry(entry, {}, cfg.defaults);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Timed out after");
    expect(r.text).toContain("(parse stage)");
    expect(r.text).toContain("partial");
  });

  it("reports a null exit code when the command stage left none", async () => {
    spawnStage
      .mockResolvedValueOnce({
        exitCode: undefined,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "",
        rawChunks: [],
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "",
      });
    const r = await runEntry(entry, {}, cfg.defaults);
    expect(r.text).toContain("exit code: null");
  });

  it("reports cancellation when the signal aborted before the final check", async () => {
    const controller = new AbortController();
    spawnStage
      .mockResolvedValueOnce({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        stdout: "hi",
        stderr: "",
        rawChunks: [],
      })
      .mockImplementationOnce(async () => {
        // Abort while the parse stage runs, so neither stage reports itself
        // as cancelled but the post-stage signal check fires.
        controller.abort();
        return {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          stdout: "hi",
          stderr: "",
          rawChunks: [],
        };
      });
    const r = await runEntry(entry, {}, cfg.defaults, controller.signal);
    expect(r.cancelled).toBe(true);
    expect(r.text).toBe("Cancelled by client.");
  });
});
