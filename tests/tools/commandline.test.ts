import { describe, expect, it } from "vitest";
import { argMode, buildCommandline, previewCommandline } from "../../src/tools/index.js";
import { slug } from "../../src/support.js";
import { toolsFor } from "../helpers.js";

function oneTool(text: string) {
  const { tools } = toolsFor(text);
  return tools[0];
}

describe("previewCommandline", () => {
  it("marks free args, named placeholders and defaults", () => {
    const free = oneTool(
      "g:\n  commands:\n    - label: F\n      command: echo\n      args: true\n",
    );
    expect(previewCommandline(free.entry)).toBe("echo '<free args…>'");

    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
        "          required: true",
      ].join("\n"),
    );
    expect(previewCommandline(named.entry)).toBe("cp '<src>'");

    const defaulted = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: D",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
        "          default: file.txt",
      ].join("\n"),
    );
    expect(previewCommandline(defaulted.entry)).toBe("cp 'src=file.txt'");

    const optional = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: O",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
      ].join("\n"),
    );
    expect(previewCommandline(optional.entry)).toBe("cp '[src]'");

    const appended = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: P",
        "      command: echo",
        "      args:",
        "        - name: extra",
        "          required: true",
      ].join("\n"),
    );
    expect(previewCommandline(appended.entry)).toBe("echo '<extra>'");

    const none = oneTool("g:\n  commands:\n    - label: X\n      command: echo\n");
    expect(previewCommandline(none.entry)).toBe("echo");

    const piped = oneTool(
      ["g:", "  commands:", "    - label: P", "      command: echo", "      pipe: tail -1"].join(
        "\n",
      ),
    );
    expect(previewCommandline(piped.entry)).toBe("echo | tail -1");
  });
});

describe("buildCommandline", () => {
  it("quotes free-form values and quotes named values into placeholders", () => {
    const free = oneTool(
      "g:\n  commands:\n    - label: F\n      command: echo\n      args: true\n",
    );
    expect(buildCommandline(free.entry, ["a b", "c"])).toBe("echo 'a b' 'c'");
    expect(buildCommandline(free.entry, "not-a-list")).toBe("echo");

    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: echo {msg} tail",
        "      args:",
        "        - name: msg",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, { msg: "two words" })).toBe("echo 'two words' tail");
    // A named argument without a placeholder is appended in declared order.
    const appended = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      args:",
        "        - name: extra",
        "          default: fell-back",
      ].join("\n"),
    );
    expect(buildCommandline(appended.entry, { extra: "x" })).toBe("echo 'x'");
    expect(buildCommandline(appended.entry, {})).toBe("echo 'fell-back'");
  });

  it("rejects unknown named arguments and missing required ones", () => {
    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: echo {msg}",
        "      args:",
        "        - name: msg",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, { nope: 1 })).toEqual({
      error: 'Unknown argument "nope". Allowed: msg.',
    });
    expect(buildCommandline(named.entry, {})).toEqual({
      error: 'Missing required argument "msg".',
    });
  });

  it("rejects a command that becomes empty after substitution", () => {
    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: '{msg}'",
        "      args:",
        "        - name: msg",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, {})).toEqual({
      error: "Command is empty after argument substitution.",
    });
    // An optional placeholder with no value just leaves nothing in its place.
    const echo = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: M",
        "      command: echo {msg}",
        "      args:",
        "        - name: msg",
      ].join("\n"),
    );
    expect(buildCommandline(echo.entry, {})).toBe("echo ");
  });
});

describe("buildCommandline", () => {
  it("shell-quotes free arguments (no injection)", () => {
    const { tools } = toolsFor(
      "g:\n  commands:\n    - label: E\n      command: echo\n      args: true\n",
    );
    expect(buildCommandline(tools[0].entry as any, ["safe", "bad; rm -rf /"])).toBe(
      "echo 'safe' 'bad; rm -rf /'",
    );
  });

  it("keeps order, applies defaults and enforces required named args", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: E",
        "      command: run",
        "      args:",
        "        - name: a",
        "          required: true",
        "        - name: b",
        "          default: x",
        "        - name: c",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { a: "1" })).toBe("run '1' 'x'");
    expect(buildCommandline(entry, { a: "1", b: "2", c: "3" })).toBe("run '1' '2' '3'");
    expect((buildCommandline(entry, {}) as any).error).toMatch(/Missing required argument "a"/);
    expect((buildCommandline(entry, { a: "1", zz: "9" }) as any).error).toMatch(
      /Unknown argument "zz"/,
    );
  });

  it("glues prefix and suffix around quoted values and omits absent optionals", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Docker",
        "      command: docker run img",
        "      args:",
        "        - name: memory",
        '          prefix: "--memory "',
        "        - name: mode",
        '          suffix: ":rw"',
        "        - name: plain",
        "          required: true",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { plain: "x" })).toBe("docker run img 'x'");
    expect(buildCommandline(entry, { plain: "x", memory: "512m" })).toBe(
      "docker run img --memory '512m' 'x'",
    );
    expect(buildCommandline(entry, { plain: "x", mode: "rw" })).toBe("docker run img 'rw':rw 'x'");
    expect(buildCommandline(entry, { plain: "x", memory: "512m", mode: "rw" })).toBe(
      "docker run img --memory '512m' 'rw':rw 'x'",
    );
  });

  it("fills placeholders in place and appends leftovers", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Checkout",
        "      command: git checkout {branch} --",
        "      args:",
        "        - name: branch",
        "          required: true",
        "        - name: verbose",
        "          default: --quiet",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { branch: "main" })).toBe("git checkout 'main' -- '--quiet'");
    expect(buildCommandline(entry, { branch: "a b", verbose: "-v" })).toBe(
      "git checkout 'a b' -- '-v'",
    );
    expect((buildCommandline(entry, {}) as any).error).toMatch(
      /Missing required argument "branch"/,
    );
    expect(previewCommandline(entry)).toMatch(/git checkout '<branch>' -- 'verbose=--quiet'/);
  });

  it("supports mid-command placeholders", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Ns",
        "      command: kubectl --namespace {ns} get pods",
        "      args:",
        "        - name: ns",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(tools[0].entry as any, { ns: "prod" })).toBe(
      "kubectl --namespace 'prod' get pods",
    );
  });

  it("keeps the parse stage out of the command line (the runner pipes it)", () => {
    const { tools } = toolsFor(
      "g:\n  commands:\n    - label: P\n      command: cat f | sort\n      pipe: wc -l\n",
    );
    expect(previewCommandline(tools[0].entry as any)).toBe("cat f | sort | wc -l");
    expect(buildCommandline(tools[0].entry as any, undefined)).toBe("cat f | sort");
  });
});

describe("argMode", () => {
  it("classifies args: true, named lists and everything else", () => {
    expect(argMode({ args: true } as any).mode).toBe("free");
    const named = argMode({
      args: [{ name: "a" }, { nope: true }, { name: "b", default: 3 }],
    } as any);
    expect(named.mode).toBe("named");
    expect(named.specs).toEqual([
      { name: "a", description: "Value for a", required: false, default: undefined },
      { name: "b", description: "Value for b", required: false, default: "3" },
    ]);
    expect(argMode({ args: false } as any).mode).toBe("none");
    expect(argMode({ args: [{ description: "no name" }] } as any).mode).toBe("none");
    expect(argMode({} as any).mode).toBe("none");
  });
});

describe("slug", () => {
  it("slugifies names and falls back to cmd when nothing survives", () => {
    expect(slug("Run All Tests!")).toBe("run_all_tests");
    expect(slug("///")).toBe("label");
  });
});

describe("commandline corners", () => {
  it("handles placeholders without a declared argument", () => {
    const entry = {
      cmd: { command: "echo {gone}", label: "X" },
      args: { mode: "named" as const, specs: [{ name: "other", required: true }] },
    } as any;
    expect(previewCommandline(entry)).toContain("{gone}");
    expect(buildCommandline(entry, { other: "x" })).toEqual({
      error: 'Placeholder "{gone}" has no matching named argument.',
    });
  });

  it("treats non-object named arguments as no values", () => {
    const entry = {
      cmd: { command: "echo {a}", label: "X" },
      args: { mode: "named" as const, specs: [{ name: "a", required: true }] },
    } as any;
    expect(buildCommandline(entry, "scalar")).toEqual({
      error: 'Missing required argument "a".',
    });
  });
});
