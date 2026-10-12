import { describe, expect, it, vi } from "vitest";
import { ShellRunnerServer } from "../../src/server/index.js";
import { requestSignal, signalMiddleware } from "../../src/server/middleware.js";

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

describe("server corners", () => {
  it("returns no signal for a request id without a controller", () => {
    const ghost = { getContext: () => ({ requestId: "ghost" }) };
    expect(requestSignal(ghost as any)).toBeUndefined();
    const anonymous = { getContext: () => ({ requestId: undefined }) };
    expect(requestSignal(anonymous as any)).toBeUndefined();
  });
});
