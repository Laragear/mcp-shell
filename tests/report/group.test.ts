import { describe, expect, it } from "vitest";
import { emitGroupTemplate } from "../../src/report/group.js";

describe("emitGroupTemplate", () => {
  it("emits group settings and the starter command for an empty group", () => {
    const lines = emitGroupTemplate("mygroup", { timeout: 30, cwd: "./x" });
    const text = lines.join("\n");
    expect(text).toContain("mygroup:");
    expect(text).toContain("# timeout: '30'   # seconds, group-wide default");
    expect(text).toContain("# cwd: ./x   # group-wide default working directory");
    expect(text).toContain("# env:");
    expect(text).toContain("command: npm test");
    expect(text).toContain("Full reference of optional command keys:");
  });

  it("emits declared commands and a real env mapping", () => {
    const lines = emitGroupTemplate("g", {
      env: { CI: "true" },
      commands: [
        {
          label: "Build",
          command: "make {target}",
          args: [{ name: "target", required: true, prefix: "--target ", suffix: ":rw" }],
          description: "Build it",
          timeout: 9,
          cwd: "./sub",
          env: { CI: "true" },
          pipe: "tail -1",
          check: { contains: ["ok"], regex: "\\d" },
          max_output: 500,
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("  env:");
    expect(text).toContain("CI: 'true'");
    expect(text).toContain("label: Build");
    expect(text).toContain("command: 'make {target}'");
    expect(text).toContain("- name: target");
    expect(text).toContain("prefix: '--target '");
    expect(text).toContain("suffix: ':rw'");
    expect(text).toContain("description: Build it");
    expect(text).toContain("label: Build");
    expect(text).toContain("timeout: '9'");
    expect(text).toContain("cwd: ./sub");
    expect(text).toContain("pipe: tail -1");
    expect(text).toContain("check:");
    expect(text).toContain("contains: [ok]");
    expect(text).toContain("regex: \\d");
    expect(text).toContain("max_output: '500'");
    expect(text).not.toContain("Full reference");
  });

  it("emits the args-free and args-absent variants", () => {
    const free = emitGroupTemplate("g", {
      commands: [{ label: "A", command: "echo", args: true }],
    });
    expect(free.join("\n")).toContain("args: true");
    const none = emitGroupTemplate("g", { commands: [{ label: "A", command: "echo" }] });
    expect(none.join("\n")).toContain("# args: false");
  });
});

it("emits an empty group with the starter command", () => {
  const text = emitGroupTemplate("g", {}).join("\n");
  expect(text).toContain("command: npm test");
  expect(text).not.toContain("# timeout: undefined");
});
