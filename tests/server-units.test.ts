import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { ShellRunnerServer } from "../src/server/index.js";
import { requestSignal, signalMiddleware } from "../src/server/middleware.js";
import { argValuesFor, zodInput } from "../src/server/schemas.js";
import { writeConfig } from "./helpers.js";
import * as fs from "node:fs";
import { makeTmp } from "./helpers.js";

describe("server middleware", () => {
  it("returns no signal outside a request", () => {
    const srs = new ShellRunnerServer();
    expect(requestSignal(srs.server)).toBeUndefined();
  });

  it("passes requests through untouched when there is no request id", async () => {
    const next = vi.fn(async () => "passed");
    const result = await signalMiddleware.onRequest?.(
      { method: "tools/call", request: {}, mcpContext: { requestId: undefined } } as any,
      next,
    );
    expect(result).toBe("passed");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("aborts the published signal when the chain rejects", async () => {
    const srs = new ShellRunnerServer();
    const inner = async () => {
      // In flight: the controller for this request id exists.
      await new Promise((_, reject) => setTimeout(() => reject(new Error("boom")), 30));
    };
    const run = signalMiddleware.onRequest?.(
      { method: "tools/call", request: {}, mcpContext: { requestId: "req-1" } } as any,
      inner,
    );
    await expect(run).rejects.toThrow("boom");
    // The controller is gone and aborted once the chain settles.
    expect(requestSignal(srs.server)).toBeUndefined();
  });
});

describe("zod input schemas", () => {
  it("declares required and optional named arguments", () => {
    const entry = {
      args: {
        mode: "named" as const,
        specs: [
          { name: "must", description: "required one", required: true },
          { name: "maybe", description: "optional one", required: false },
        ],
      },
    } as any;
    const schema = zodInput(entry, false);
    const parsed = schema.parse({ must: "x", junk: true });
    expect(parsed).toEqual({ must: "x", maybe: undefined });
    expect(() => schema.parse({})).toThrow();
  });

  it("declares free args and the agent output_to only when allowed", () => {
    const free = zodInput({ args: { mode: "free" } } as any, true);
    expect(free.parse({ args: ["a"], output_to: "ok.txt" })).toEqual({
      args: ["a"],
      output_to: "ok.txt",
    });
    expect(() => free.parse({ args: ["a"], output_to: "bad name!.txt" })).toThrow();

    const strict = zodInput({ args: { mode: "none" } } as any, false);
    expect(strict.parse({ whatever: 1 })).toEqual({});
  });

  it("marshals arguments per argument mode", () => {
    const free = { args: { mode: "free" as const } } as any;
    expect(argValuesFor(free, { args: ["x"] })).toEqual(["x"]);
    const named = { args: { mode: "named" as const, specs: [] } } as any;
    expect(argValuesFor(named, { a: 1, output_to: true })).toEqual({ a: 1 });
    const none = { args: { mode: "none" as const } } as any;
    expect(argValuesFor(none, { a: 1 })).toEqual({});
  });
});

describe("ShellRunnerServer wiring", () => {
  it("survives a config signature that cannot be serialized", () => {
    const tmp = makeTmp("sr-sig-");
    const prev = process.env.SHELL_RUNNER_CONFIG;
    process.env.SHELL_RUNNER_CONFIG = writeConfig(
      tmp,
      "g:\n  commands:\n    - label: Ok\n      command: echo\n",
    );
    try {
      const srs = new ShellRunnerServer();
      const circular: any = { text: "circular" };
      circular.self = circular;
      expect(srs.syncTools({ groups: {}, defaults: {}, issues: [circular] } as any)).toBe(true);
      expect(srs.syncTools({ groups: {}, defaults: {}, issues: [circular] } as any)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SHELL_RUNNER_CONFIG;
      else process.env.SHELL_RUNNER_CONFIG = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("connects a caller-owned transport", async () => {
    const srs = new ShellRunnerServer();
    const transport = {
      start: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    await srs.connect(transport as any);
    expect(transport.start).toHaveBeenCalled();
  });

  it("serves stdio on injected streams until stdin closes", async () => {
    const srs = new ShellRunnerServer();
    const chunks: string[] = [];
    const stdin = new Readable({ read() {} });
    stdin.push(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      })}\n`,
    );
    const run = srs.serve({
      stdin,
      stdout: new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk.toString());
          cb();
        },
      }),
    });
    // Give the initialize round-trip a moment, then end stdin: serve resolves
    // when the transport closes.
    await new Promise((d) => setTimeout(d, 200));
    await vi.waitFor(() => expect(chunks.join()).toContain("shell-runner"));
    stdin.push(null);
    await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("serve hung")), 5000)),
    ]);
  }, 10000);
});
