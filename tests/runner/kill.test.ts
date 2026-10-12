import { describe, expect, it, vi } from "vitest";
import { killRunningChildren, trackRunningChild } from "../../src/runner/kill.js";

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

describe("killRunningChildren corners", () => {
  it("ignores children without a pid and tolerates killing failures", () => {
    const noPid = { kill: vi.fn(), on: vi.fn() };
    trackRunningChild(noPid as any);
    const throwing = {
      pid: 4194305,
      kill: vi.fn(() => {
        throw new Error("gone");
      }),
      on: vi.fn(),
    };
    trackRunningChild(throwing as any);
    expect(() => killRunningChildren()).not.toThrow();
    expect(throwing.kill).toHaveBeenCalled();
  });

  it("uses child.kill when the group kill fails on win32", () => {
    const win32 = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const kill = vi.fn(() => {
        throw new Error("nope");
      });
      trackRunningChild({ pid: process.pid, kill, on: vi.fn() } as any);
      expect(() => killRunningChildren()).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", win32 as number);
    }
  });
});
